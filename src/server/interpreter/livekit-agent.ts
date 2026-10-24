import "server-only";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { AccessToken, TrackSource as GrantSource } from "livekit-server-sdk";
import { db } from "../db";
import { getTtsProvider } from "../providers/tts";
import type { RivaConfig } from "../providers/stt";
import { parseWav, resampleInt16, toMono } from "./audio";
import { interpretUtterance, type InterpreterMessage, type InterpreterOutput } from "./pipeline";
import { RivaStream } from "./riva-stream";
import { segmenterOptions, UtteranceSegmenter } from "./segmenter";

import { ASSISTANT_MAX_MS, ASSISTANT_STATE_TOPIC, INTERPRETER_IDENTITY, INTERPRETER_NAME, INTERPRETER_TOPIC, interpreterLanguageCodes, interpreterTrackName } from "./constants";
import { indicAsrSupports, indicCovers, readIndicConfig } from "../providers/indic";
import { IndicAsrStream } from "./indic-asr-stream";
import { stripWakePhrase } from "../../lib/voice-commands";

type Utt = { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number; commitAt?: number };
/** Longest we hold a sentence waiting for the assistant's verdict before translating it anyway. */
const WAKE_HOLD_MS = 3000;
/** Until a caller's browser reports its "Hey Mind" state, hold their first sentences for this long after we start hearing them. */
const UNKNOWN_STATE_MS = 8000;
import { IndicTtsStream, TTS_RATE } from "./indic-tts-stream";
export { INTERPRETER_IDENTITY };

const OUT_RATE = 48_000; // matches TTS_RATE, so streamed Indic audio needs no resampling
void TTS_RATE;
const DEBUG = process.env.INTERPRETER_DEBUG === "1";
const FRAME = OUT_RATE / 100; // 10 ms
const encoder = new TextEncoder();

type Person = { userId: string; label: string; language: string; consent: boolean };
export type AgentConfig = { livekitUrl: string; apiKey: string; apiSecret: string; riva: RivaConfig };

/** One language's voice in the call: a published audio track that plays translations in order. */
class LanguageVoice {
  private chain: Promise<void> = Promise.resolve();
  publication: LocalTrackPublication | null = null;
  readonly source = new AudioSource(OUT_RATE, 1, 400);
  /** Indic Speak streams audio as it's generated (English + 22 Indic languages). */
  private indic: IndicTtsStream | null = null;
  private carry = new Int16Array(0);

  constructor(readonly language: string) {
    const base = readIndicConfig().tts;
    if (base && indicCovers(language)) {
      this.indic = new IndicTtsStream(base, language, (pcm) => this.push(pcm));
      this.indic.start();
    }
  }

  /** Streamed audio → 10 ms frames into the call track, strictly in order. */
  private push(pcm: Int16Array) {
    const all = new Int16Array(this.carry.length + pcm.length);
    all.set(this.carry);
    all.set(pcm, this.carry.length);
    const whole = all.length - (all.length % FRAME);
    this.carry = all.slice(whole);
    const frames = all.subarray(0, whole);
    this.chain = this.chain
      .then(async () => {
        for (let i = 0; i < frames.length; i += FRAME) await this.source.captureFrame(new AudioFrame(frames.slice(i, i + FRAME), OUT_RATE, 1, FRAME));
      })
      .catch((err) => console.error("[interpreter] playback failed", (err as Error).message));
  }

  close() {
    this.indic?.close();
  }

  async speak(text: string) {
    if (this.indic) return this.indic.speak(text);
    const tts = getTtsProvider();
    if (!tts) return null;
    const t0 = Date.now();
    const out = await tts.synthesize(text, { language: this.language });
    if (!out) return null;
    const ttsMs = Date.now() - t0;
    const wav = parseWav(out.audio);
    const pcm = resampleInt16(toMono(wav.samples, wav.channels), wav.sampleRate, OUT_RATE);
    const queuedAt = Date.now();
    // Synthesis runs in parallel; playback is strictly one line after another.
    return new Promise<{ ttsMs: number; queueMs: number; playAt: number }>((resolve) => {
      this.chain = this.chain.then(async () => {
        const playAt = Date.now();
        resolve({ ttsMs, queueMs: playAt - queuedAt, playAt });
        for (let i = 0; i < pcm.length; i += FRAME) {
          const chunk = new Int16Array(FRAME);
          chunk.set(pcm.subarray(i, i + FRAME));
          await this.source.captureFrame(new AudioFrame(chunk, OUT_RATE, 1, FRAME));
        }
        await this.source.waitForPlayout();
      }).catch((err) => console.error("[interpreter] playback failed", (err as Error).message));
    });
  }
}

/** Listens to one consenting speaker: voice detection → streaming recognition → interpretation. */
class SpeakerSession {
  private riva: RivaStream | null = null;
  private indic: IndicAsrStream | null = null;
  private segmenter = new UtteranceSegmenter(segmenterOptions());
  private speechStartAt = 0;
  private stopped = false;

  constructor(
    readonly userId: string,
    private track: RemoteTrack,
    readonly language: string,
    rivaConfig: RivaConfig,
    onUtterance: (u: { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number }) => void,
  ) {
    const base = readIndicConfig().asr;
    if (base && indicAsrSupports(language)) {
      // IndicConformer finds the end of each utterance itself (VAD) and answers ~85 ms after the pause.
      const pause = Number(process.env.INTERPRETER_PAUSE_MS) || 500;
      this.indic = new IndicAsrStream(base, language, Math.min(2000, Math.max(300, pause)), onUtterance, (m) => console.error(`[interpreter] indic asr (${userId}): ${m}`));
    } else {
      this.riva = new RivaStream(rivaConfig, language, onUtterance, (m) => console.error(`[interpreter] riva (${userId}): ${m}`));
    }
  }

  get engine() {
    return this.indic ? "indic" : "riva";
  }

  async run() {
    this.indic?.start();
    this.riva?.start();
    const stream = new AudioStream(this.track, 16000, 1);
    try {
      const reader = stream.getReader();
      while (!this.stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        const samples = frame.data;
        const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
        if (this.indic) {
          this.indic.append(bytes);
          continue;
        }
        this.riva!.append(bytes);
        const ev = this.segmenter.push(samples);
        if (ev?.type === "start") this.speechStartAt = Date.now();
        else if (ev?.type === "end") {
          if (DEBUG) console.log(`[interpreter] ${this.userId} end of speech: ${ev.speechMs} ms voiced, detected ${Date.now() - this.segmenter.lastVoiceAt} ms after last voice${ev.forced ? " (forced)" : ""}`);
          this.riva!.commit(this.speechStartAt || Date.now(), this.segmenter.lastVoiceAt);
        }
      }
    } catch (err) {
      if (!this.stopped) console.error("[interpreter] audio stream ended", (err as Error).message);
    }
  }

  stop() {
    this.stopped = true;
    this.riva?.close();
    this.indic?.close();
  }
}

/**
 * The AI interpreter for one meeting: joins the LiveKit room as a participant, listens to every
 * consenting speaker, and speaks translations on one audio track per language in the call.
 */
export class MeetingInterpreter {
  private room = new Room();
  private people = new Map<string, Person>();
  private speakers = new Map<string, SpeakerSession>();
  private voices = new Map<string, LanguageVoice>();
  private tracks = new Map<string, RemoteTrack>(); // identity → mic track
  /** People currently talking to the voice assistant (their words are for the assistant, not the call). */
  private withAssistant = new Map<string, number>();
  /** People with "Hey Mind" listening on: their sentences wait briefly for the assistant's verdict. */
  private wakeListening = new Set<string>();
  /** Whose browser has told us its "Hey Mind" state, and when we started hearing each person. */
  private stateKnown = new Set<string>();
  private heardSince = new Map<string, number>();
  private held = new Map<string, { u: Utt; timer: ReturnType<typeof setTimeout> }[]>();
  private lastRoster = "";
  private startedAt: Date | null = null;
  /** False once LiveKit drops us (e.g. the same identity joined elsewhere); the supervisor rejoins. */
  connected = false;
  private emptySince: number | null = null;

  constructor(
    readonly meeting: { id: string; roomId: string },
    private cfg: AgentConfig,
  ) {}

  async start() {
    const at = new AccessToken(this.cfg.apiKey, this.cfg.apiSecret, { identity: INTERPRETER_IDENTITY, name: INTERPRETER_NAME, ttl: 6 * 3600, metadata: JSON.stringify({ agent: "interpreter" }) });
    at.addGrant({ room: this.meeting.roomId, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: true, canPublishSources: [GrantSource.MICROPHONE] });
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind !== TrackKind.KIND_AUDIO || p.identity === INTERPRETER_IDENTITY) return;
      this.tracks.set(p.identity, track);
      void this.refresh();
    });
    this.room.on(RoomEvent.TrackUnsubscribed, (_t: RemoteTrack, _pub: RemoteTrackPublication, p: RemoteParticipant) => this.dropSpeaker(p.identity));
    this.room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      this.dropSpeaker(p.identity);
      void this.refresh();
    });
    this.room.on(RoomEvent.ParticipantConnected, () => void this.refresh());
    // A caller's browser says when "Hey Mind" listening is on, whether each thing they said was for the
    // assistant, and when they start and stop talking to it.
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== ASSISTANT_STATE_TOPIC || !p) return;
      let m: { active?: boolean; wake?: boolean; verdict?: "assistant" | "call" };
      try {
        m = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      const id = p.identity;
      if (DEBUG && (m.verdict || m.active !== undefined || (m.wake !== undefined && !this.stateKnown.has(id)))) console.log(`[interpreter] ${id} says ${JSON.stringify(m)}; holding ${this.held.get(id)?.length ?? 0}`);
      if (typeof m.wake === "boolean") this.stateKnown.add(id);
      if (m.wake === true) this.wakeListening.add(id);
      if (m.wake === false) {
        this.wakeListening.delete(id);
        this.release(id, true);
      }
      if (m.verdict) this.release(id, m.verdict === "call");
      if (m.active === true || m.verdict === "assistant") this.withAssistant.set(id, Date.now());
      if (m.active === false) this.withAssistant.delete(id);
    });
    this.room.on(RoomEvent.Disconnected, () => {
      this.connected = false;
    });
    await this.room.connect(this.cfg.livekitUrl, await at.toJwt(), { autoSubscribe: true, dynacast: false });
    this.connected = true;
    console.log(`[interpreter] joined ${this.meeting.roomId}`);
    await this.refresh();
  }

  private dropSpeaker(identity: string) {
    this.release(identity, false);
    this.wakeListening.delete(identity);
    this.stateKnown.delete(identity);
    this.heardSince.delete(identity);
    this.tracks.delete(identity);
    this.speakers.get(identity)?.stop();
    this.speakers.delete(identity);
  }

  private send(message: InterpreterMessage | { type: "roster"; languages: Record<string, string>; voices: string[] }) {
    void this.room.localParticipant?.publishData(encoder.encode(JSON.stringify(message)), { reliable: true, topic: INTERPRETER_TOPIC }).catch(() => {});
  }

  private presentLanguages() {
    const present = [...this.room.remoteParticipants.keys()].filter((id) => id !== INTERPRETER_IDENTITY);
    return new Map(present.flatMap((id) => (this.people.has(id) ? [[id, this.people.get(id)!.language] as const] : [])));
  }

  /** Re-read who is here, their languages and consent; start/stop listeners and voices to match. */
  async refresh() {
    const m = await db.meeting.findUnique({
      where: { id: this.meeting.id },
      select: { startedAt: true, participants: { where: { removedAt: null }, select: { userId: true, callLanguage: true, transcriptionConsentAt: true, user: { select: { displayName: true, preferredLanguage: true } } } } },
    });
    if (!m) return;
    this.startedAt = m.startedAt;
    this.people = new Map(
      m.participants.map((p) => {
        const lang = p.callLanguage ?? p.user.preferredLanguage;
        return [p.userId, { userId: p.userId, label: p.user.displayName, language: interpreterLanguageCodes().includes(lang) ? lang : "en", consent: !!p.transcriptionConsentAt }];
      }),
    );
    const langs = this.presentLanguages();
    const distinct = new Set(langs.values());

    // Listen only to people who consented; restart if their language changed.
    for (const [identity, track] of this.tracks) {
      const person = this.people.get(identity);
      const current = this.speakers.get(identity);
      if (!person?.consent) {
        current?.stop();
        this.speakers.delete(identity);
        continue;
      }
      if (current && current.language === person.language) continue;
      current?.stop();
      if (!this.heardSince.has(identity)) this.heardSince.set(identity, Date.now());
      const session = new SpeakerSession(identity, track, person.language, this.cfg.riva, (u) => void this.onUtterance(identity, u));
      this.speakers.set(identity, session);
      void session.run();
    }

    // One voice per language, needed only when more than one language is present.
    const needed = distinct.size > 1 ? distinct : new Set<string>();
    for (const lang of needed) {
      if (this.voices.has(lang)) continue;
      const voice = new LanguageVoice(lang);
      this.voices.set(lang, voice);
      const track = LocalAudioTrack.createAudioTrack(interpreterTrackName(lang), voice.source);
      voice.publication = await this.room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: false }));
    }
    for (const [lang, voice] of this.voices) {
      if (needed.has(lang)) continue;
      if (voice.publication?.sid) await this.room.localParticipant!.unpublishTrack(voice.publication.sid).catch(() => {});
      voice.close();
      this.voices.delete(lang);
    }

    // Tell clients who speaks what (for muting other-language voices) and which voices exist.
    const roster = JSON.stringify({ languages: Object.fromEntries(langs), voices: [...this.voices.keys()].sort() });
    if (roster !== this.lastRoster) {
      this.lastRoster = roster;
      this.send({ type: "roster", ...JSON.parse(roster) });
    }
  }

  private async onUtterance(identity: string, u: Utt) {
    if (DEBUG) console.log(`[interpreter] ${identity} "${u.text.slice(0, 60)}": ${u.commitAt ? `commit +${u.commitAt - u.speechEndAt} ms, result +${u.resultAt - u.commitAt} ms` : `result +${u.resultAt - u.speechEndAt} ms after speech end (Indic)`}`);
    const person = this.people.get(identity);
    if (!person?.consent) return; // consent withdrawn while they were speaking
    // "Hey Mind …" and the conversation that follows are for the assistant: don't translate them to the call.
    const since = this.withAssistant.get(identity);
    if (since && Date.now() - since < ASSISTANT_MAX_MS) return;
    if (stripWakePhrase(u.text).woke) return;
    // Recognition can clip "Hey Mind" off the start, so for someone listening for it, wait (briefly) for
    // their browser's assistant to say whether this was a command before translating it.
    const unknownYet = !this.stateKnown.has(identity) && Date.now() - (this.heardSince.get(identity) ?? 0) < UNKNOWN_STATE_MS;
    if (this.wakeListening.has(identity) || unknownYet) {
      if (DEBUG) console.log(`[interpreter] ${identity} holding "${u.text.slice(0, 30)}" (${unknownYet ? "state unknown" : "Hey Mind on"})`);
      const list = this.held.get(identity) ?? [];
      const item = { u, timer: setTimeout(() => this.release(identity, true, item), WAKE_HOLD_MS) };
      list.push(item);
      this.held.set(identity, list);
      return;
    }
    await this.translate(identity, u);
  }

  /** Translate (or drop) what a person said while we waited for the assistant's verdict. */
  private release(identity: string, translate: boolean, only?: { u: Utt; timer: ReturnType<typeof setTimeout> }) {
    const list = this.held.get(identity) ?? [];
    const take = only ? list.filter((x) => x === only) : list;
    this.held.set(identity, only ? list.filter((x) => x !== only) : []);
    if (DEBUG && take.length) console.log(`[interpreter] ${identity} ${translate ? "translating" : "dropping"} ${take.length} held${only ? " (timeout)" : ""}`);
    for (const x of take) {
      clearTimeout(x.timer);
      if (translate) void this.translate(identity, x.u);
    }
  }

  private async translate(identity: string, u: Utt) {
    const person = this.people.get(identity);
    if (!person?.consent) return;
    const targets = [...new Set([...this.presentLanguages().entries()].filter(([id]) => id !== identity).map(([, l]) => l))];
    const out: InterpreterOutput = {
      speak: async (language, text) => this.voices.get(language)?.speak(text) ?? null,
      send: (msg) => this.send(msg),
    };
    try {
      await interpretUtterance({ meeting: { id: this.meeting.id, startedAt: this.startedAt }, speaker: { userId: identity, label: person.label }, utt: u, targetLanguages: targets, out });
    } catch (err) {
      console.error("[interpreter] utterance failed", (err as Error).message);
    }
  }

  /** How long the room has had no people in it (the agent must not keep an empty call alive). */
  emptyForMs(now = Date.now()) {
    const humans = [...this.room.remoteParticipants.keys()].filter((id) => id !== INTERPRETER_IDENTITY).length;
    if (humans > 0) this.emptySince = null;
    else this.emptySince ??= now;
    return this.emptySince === null ? 0 : now - this.emptySince;
  }

  async stop() {
    this.connected = false;
    for (const s of this.speakers.values()) s.stop();
    this.speakers.clear();
    for (const v of this.voices.values()) v.close();
    this.voices.clear();
    await this.room.disconnect().catch(() => {});
    console.log(`[interpreter] left ${this.meeting.roomId}`);
  }
}
