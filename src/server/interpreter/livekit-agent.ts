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
import { isStale, interpretUtterance, type InterpreterMessage, type InterpreterOutput } from "./pipeline";
import { RivaStream } from "./riva-stream";
import { catchUpRate, timeStretch } from "./time-stretch";
import { allVoices, listMagpieVoices, magpieCovers, readMagpieConfig, streamMagpieSpeech, voiceIn, type MagpieVoice } from "../providers/magpie";
import { prepareTranslation, type PhraseContext } from "../services/translation";
import { PHRASE_MAX_MS, PHRASE_PAUSE_MS, phraseMode, segmenterOptions, UtteranceSegmenter, WAKE_PAUSE_MS } from "./segmenter";

import { ASSISTANT_MAX_MS, ASSISTANT_STATE_TOPIC, INTERPRETER_IDENTITY, INTERPRETER_NAME, INTERPRETER_TOPIC, interpreterLanguageCodes, interpreterTrackName } from "./constants";
import { indicAsrSupports, indicCovers, readIndicConfig } from "../providers/indic";
import { IndicAsrStream } from "./indic-asr-stream";
import { OfflineAsr, offlineAsrLanguages } from "./offline-asr";
import { createOpenAiSttProvider, createRivaOfflineSttProvider, readSttConfig } from "../providers/stt";
import { stripWakePhrase } from "../../lib/voice-commands";

const ROSTER_REPEAT_MS = 5_000;
type Utt = { text: string; language: string; speechStartAt: number; speechEndAt: number; resultAt: number; commitAt?: number };
/** Longest we hold a sentence waiting for the assistant's verdict before translating it anyway. The verdict usually
 * comes in 1–2 s (and releases the sentence at once); under load the browser's check can take longer, and a
 * command translated to the other callers is worse than a short delay. */
const WAKE_HOLD_MS = 6000;
/** Speech starting this soon after a "Hey Mind" line ends is the rest of that command. */
const WAKE_CONTINUES_MS = 1500;
/** A command reported by the browser covers speech up to this long before the report (its clips are ≤ 15 s). */
const COMMAND_LOOKBACK_MS = 15_000;
/** A phrase continues the speaker's previous ones if it starts within this long of them; up to this many are given. */
const CONTEXT_GAP_MS = 4000;
const CONTEXT_PHRASES = 3;
/** While the browser is still checking a clip, held lines keep waiting, up to this long in total. */
const CHECK_MAX_MS = 15_000;
/** A sentence waiting for the "Hey Mind" verdict, with its translations already being made (used only if it isn't a command). */
type Held = { u: Utt; heldAt: number; timer: ReturnType<typeof setTimeout>; prepared: Map<string, Promise<string | null>> };
/** Until a caller's browser reports its "Hey Mind" state, hold their first sentences for this long after we start hearing them. */
const UNKNOWN_STATE_MS = 8000;
import { IndicTtsStream, TTS_RATE } from "./indic-tts-stream";
export { INTERPRETER_IDENTITY };

/**
 * Offline recognition for the languages in INTERPRETER_OFFLINE_ASR_LANGUAGES; others stream to Riva. The server is
 * INTERPRETER_OFFLINE_ASR_URL (Riva offline, e.g. Parakeet from deploy/gpu-host) or else the STT_* server (Granite).
 */
const sttConfig = readSttConfig();
const offlineStt = process.env.INTERPRETER_OFFLINE_ASR_URL
  ? createRivaOfflineSttProvider(process.env.INTERPRETER_OFFLINE_ASR_URL)
  : sttConfig
    ? createOpenAiSttProvider(sttConfig)
    : null;
const OFFLINE_ASR_LANGUAGES = offlineAsrLanguages(offlineStt);
const OUT_RATE = 48_000; // matches TTS_RATE, so streamed Indic audio needs no resampling
void TTS_RATE;
const DEBUG = process.env.INTERPRETER_DEBUG === "1";
const FRAME = OUT_RATE / 100; // 10 ms
const encoder = new TextEncoder();

type Person = { userId: string; label: string; language: string; consent: boolean; voice: string | null };
export type AgentConfig = { livekitUrl: string; apiKey: string; apiSecret: string; riva: RivaConfig };

/** One language's voice in the call: a published audio track that plays translations in order, each line in its speaker's chosen voice. */
class LanguageVoice {
  private chain: Promise<void> = Promise.resolve();
  publication: LocalTrackPublication | null = null;
  readonly source = new AudioSource(OUT_RATE, 1, 400);
  /** Indic Speak streams audio as it's generated (English + 22 Indic languages). */
  private indic: IndicTtsStream | null = null;
  private carry = new Int16Array(0);

  constructor(readonly language: string) {
    const base = readIndicConfig().tts;
    // Indic Speak has a single voice: when it's on, speakers' voice choices don't apply to its languages.
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

  /**
   * Speak `text` on this language's track. Audio starts being made at once (Magpie streams it; other voices
   * make a whole file), but playback keeps the order of the calls, so a sentence spoken clause by clause plays
   * in order even if a later clause is ready first. Resolves when this text starts playing.
   */
  speak(text: string, voice: string | null = null): Promise<{ ttsMs: number; queueMs: number; playAt: number } | null> {
    if (this.indic) return this.indic.speak(text);
    const t0 = Date.now();
    let readyAt = 0;
    const audio = this.makeAudio(text, voice).then((a) => {
      readyAt = Date.now();
      return a;
    });
    return new Promise((resolve) => {
      this.chain = this.chain
        .then(async () => {
          const a = await audio;
          if (!a) return resolve(null);
          const playAt = Date.now();
          const waited = Math.max(0, playAt - readyAt);
          resolve({ ttsMs: readyAt - t0, queueMs: waited, playAt });
          // Behind (this waited for the previous sentence to finish)? Speak a little faster to catch up.
          const rate = catchUpRate(waited);
          let source: AsyncIterable<Int16Array> = a;
          if (rate > 1) {
            const parts: Int16Array[] = [];
            for await (const pcm of a) parts.push(pcm);
            const whole = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const p of parts) {
              whole.set(p, at);
              at += p.length;
            }
            const fast = timeStretch(whole, rate, OUT_RATE);
            source = (async function* () {
              yield fast;
            })();
          }
          let rest = new Int16Array(0);
          for await (const pcm of source) {
            const all = new Int16Array(rest.length + pcm.length);
            all.set(rest);
            all.set(pcm, rest.length);
            const whole = all.length - (all.length % FRAME);
            for (let i = 0; i < whole; i += FRAME) await this.source.captureFrame(new AudioFrame(all.slice(i, i + FRAME), OUT_RATE, 1, FRAME));
            rest = all.slice(whole);
          }
          if (rest.length) {
            const last = new Int16Array(FRAME);
            last.set(rest);
            await this.source.captureFrame(new AudioFrame(last, OUT_RATE, 1, FRAME));
          }
          await this.source.waitForPlayout();
        })
        .catch((err) => {
          console.error("[interpreter] playback failed", (err as Error).message);
          resolve(null);
        });
    });
  }

  /** The audio for `text` as 16-bit PCM at OUT_RATE: streamed from Magpie when it covers the language, else a whole file. */
  private async makeAudio(text: string, voice: string | null): Promise<AsyncIterable<Int16Array> | null> {
    if (readMagpieConfig() && magpieCovers(this.language)) {
      const stream = await streamMagpieSpeech(text, this.language, { sampleRate: OUT_RATE, voice }).catch((err) => {
        console.warn("[interpreter] streamed voice failed, using the whole-file voice:", (err as Error).message);
        return null;
      });
      if (stream) return readAhead(stream);
    }
    const tts = getTtsProvider();
    const out = tts ? await tts.synthesize(text, { language: this.language }).catch(() => null) : null;
    if (!out) return null;
    const wav = parseWav(out.audio);
    const pcm = resampleInt16(toMono(wav.samples, wav.channels), wav.sampleRate, OUT_RATE);
    return (async function* () {
      yield pcm;
    })();
  }
}

/**
 * Read a byte stream to the end straight away (so a clause waiting its turn doesn't hold the voice server's
 * connection open) while handing out 16-bit samples as they arrive.
 */
function readAhead(stream: ReadableStream<Uint8Array>): AsyncIterable<Int16Array> {
  const chunks: Int16Array[] = [];
  let done = false;
  let failed: unknown = null;
  const waiting: { wake: (() => void) | null } = { wake: null };
  void (async () => {
    const reader = stream.getReader();
    let odd: number | null = null;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        let bytes = value;
        if (odd !== null) {
          const joined = new Uint8Array(bytes.length + 1);
          joined[0] = odd;
          joined.set(bytes, 1);
          bytes = joined;
          odd = null;
        }
        if (bytes.length % 2) {
          odd = bytes[bytes.length - 1];
          bytes = bytes.subarray(0, bytes.length - 1);
        }
        if (bytes.length) chunks.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)));
        waiting.wake?.();
      }
    } catch (err) {
      failed = err;
    } finally {
      done = true;
      waiting.wake?.();
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (chunks.length) {
          yield chunks.shift()!;
          continue;
        }
        if (done) {
          if (failed) console.warn("[interpreter] voice stream ended early:", (failed as Error).message);
          return;
        }
        await new Promise<void>((r) => (waiting.wake = r));
        waiting.wake = null;
      }
    },
  };
}

/** Listens to one consenting speaker: voice detection → recognition (offline or streaming) → interpretation. */
class SpeakerSession {
  private riva: RivaStream | null = null;
  private indic: IndicAsrStream | null = null;
  /** Offline recognition: one request per finished utterance, cut by our own voice detector. */
  private offline: OfflineAsr | null = null;
  // Starts with the longer "Hey Mind" pause until the caller's browser has said whether it's listening.
  private segmenter = new UtteranceSegmenter({ ...segmenterOptions(), endSilenceMs: Math.max(segmenterOptions().endSilenceMs, WAKE_PAUSE_MS) });

  /** How much silence ends a phrase for this speaker, and (0 = off) when long speech is cut at a dip. */
  setPause(p: { pauseMs: number; phraseMs: number }) {
    if (this.segmenter.endSilenceMs !== p.pauseMs) this.segmenter.setEndSilence(p.pauseMs);
    this.segmenter.setPhraseMs(p.phraseMs);
  }
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
    } else if (offlineStt && OFFLINE_ASR_LANGUAGES.has(language)) {
      this.offline = new OfflineAsr(offlineStt, language, onUtterance, (m) => console.error(`[interpreter] offline asr (${userId}): ${m}`));
    } else {
      this.riva = new RivaStream(rivaConfig, language, onUtterance, (m) => console.error(`[interpreter] riva (${userId}): ${m}`));
    }
  }

  get engine() {
    return this.indic ? "indic" : this.offline ? "offline" : "riva";
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
        const asr = (this.offline ?? this.riva)!;
        asr.append(bytes);
        const ev = this.segmenter.push(samples);
        if (ev?.type === "start") this.speechStartAt = Date.now();
        else if (ev?.type === "end") {
          if (DEBUG) console.log(`[interpreter] ${this.userId} end of speech: ${ev.speechMs} ms voiced, detected ${Date.now() - this.segmenter.lastVoiceAt} ms after last voice${ev.forced ? " (forced)" : ""}`);
          asr.commit(this.speechStartAt || Date.now(), this.segmenter.lastVoiceAt);
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
    this.offline?.close();
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
  /** Magpie's voices per language (refreshed with the roster; the provider caches it). */
  private catalog = new Map<string, MagpieVoice[]>();
  private tracks = new Map<string, RemoteTrack>(); // identity → mic track
  /** People currently talking to the voice assistant (their words are for the assistant, not the call). */
  private withAssistant = new Map<string, number>();
  /** People with "Hey Mind" listening on: their sentences wait briefly for the assistant's verdict. */
  private wakeListening = new Set<string>();
  /** Whose browser has told us its "Hey Mind" state, and when we started hearing each person. */
  private stateKnown = new Set<string>();
  private heardSince = new Map<string, number>();
  /** Until when a person's speech still continues their last "Hey Mind" command (wall clock). */
  private wokeUntil = new Map<string, number>();
  /** Interpretation on (translate and speak), or transcription only. */
  private interpreting = false;
  /** Each speaker's last phrases (phrase-by-phrase mode), with their translations, for the next phrase's context. */
  private recent = new Map<string, { text: string; endAt: number; translations: Map<string, string> }[]>();
  /** When each person's browser started checking a clip for "Hey Mind" (cleared by its verdict). */
  private checkingSince = new Map<string, number>();
  /** When each person's browser said "that was a command" (recent ones). */
  private commandsAt = new Map<string, number[]>();
  private held = new Map<string, Held[]>();
  private lastRoster = "";
  private lastRosterAt = 0;
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
      let m: { active?: boolean; wake?: boolean; verdict?: "assistant" | "call"; checking?: boolean };
      try {
        m = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      const id = p.identity;
      if (DEBUG && (m.verdict || m.active !== undefined || (m.wake !== undefined && !this.stateKnown.has(id)))) console.log(`[interpreter] ${id} says ${JSON.stringify(m)}; holding ${this.held.get(id)?.length ?? 0}`);
      if (m.checking === true) this.checkingSince.set(id, Date.now());
      if (m.checking === false) this.checkingSince.delete(id);
      if (m.verdict) this.checkingSince.delete(id);
      if (typeof m.wake === "boolean") this.stateKnown.add(id);
      if (m.wake === true) this.wakeListening.add(id);
      if (m.wake === false) {
        this.wakeListening.delete(id);
        this.release(id, true);
      }
      this.speakers.get(id)?.setPause(this.pauseFor(id));
      if (m.verdict === "assistant") {
        const now = Date.now();
        this.commandsAt.set(id, [...(this.commandsAt.get(id) ?? []).filter((t) => now - t < ASSISTANT_MAX_MS), now]);
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

  /** Speak a translation on its language's track in the voice the speaker chose (as close as that language has). */
  private async speakIn(language: string, text: string, speakerVoice: string | null) {
    const voice = this.voices.get(language);
    if (!voice) return null;
    return voice.speak(text, voiceIn(this.catalog, language, speakerVoice));
  }

  /** Re-read who is here, their languages and consent; start/stop listeners and voices to match. */
  async refresh() {
    const m = await db.meeting.findUnique({
      where: { id: this.meeting.id },
      select: { startedAt: true, interpretationEnabled: true, participants: { where: { removedAt: null }, select: { userId: true, callLanguage: true, callVoice: true, transcriptionConsentAt: true, user: { select: { displayName: true, preferredLanguage: true } } } } },
    });
    if (!m) return;
    this.startedAt = m.startedAt;
    this.interpreting = m.interpretationEnabled;
    this.catalog = this.interpreting && readMagpieConfig() ? await listMagpieVoices() : new Map();
    const offered = new Set(allVoices(this.catalog).map((v) => v.id));
    this.people = new Map(
      m.participants.map((p) => {
        const pref = p.callLanguage ?? p.user.preferredLanguage;
        const lang = interpreterLanguageCodes().includes(pref) ? pref : "en";
        // The voice others hear this person in; one the server doesn't offer means the default voice.
        const voice = p.callVoice && offered.has(p.callVoice) ? p.callVoice : null;
        return [p.userId, { userId: p.userId, label: p.user.displayName, language: lang, consent: !!p.transcriptionConsentAt, voice }];
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
      session.setPause(this.pauseFor(identity));
      this.speakers.set(identity, session);
      void session.run();
    }

    // One voice track per language, needed only when more than one language is present, and only when
    // interpreting (transcription alone needs none). Each line on it is spoken in its speaker's chosen voice.
    const needed = this.interpreting && distinct.size > 1 ? distinct : new Set<string>();
    for (const key of needed) {
      if (this.voices.has(key)) continue;
      const voice = new LanguageVoice(key);
      this.voices.set(key, voice);
      const track = LocalAudioTrack.createAudioTrack(interpreterTrackName(key), voice.source);
      voice.publication = await this.room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE, dtx: false, red: false }));
    }
    for (const [key, voice] of this.voices) {
      if (needed.has(key)) continue;
      if (voice.publication?.sid) await this.room.localParticipant!.unpublishTrack(voice.publication.sid).catch(() => {});
      voice.close();
      this.voices.delete(key);
    }

    // Tell clients who speaks what (for muting other-language voices) and which voices exist. Sent on every
    // change and repeated every few seconds: a browser that missed it (reload, reconnect) would otherwise
    // never mute the other speakers' original voices.
    const roster = JSON.stringify({ languages: Object.fromEntries(langs), voices: [...this.voices.keys()].sort() });
    if (roster !== this.lastRoster || Date.now() - this.lastRosterAt > ROSTER_REPEAT_MS) {
      this.lastRoster = roster;
      this.lastRosterAt = Date.now();
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
    // Recognition can split "Hey Mind, who is in this call?" into two results. What follows the wake phrase
    // without a real pause (it starts within WAKE_CONTINUES_MS of the previous part ending) is the same
    // command, so it isn't translated either.
    // The browser said a command ended around time T: whatever this person said in the COMMAND_LOOKBACK_MS
    // before T was that command, however it was recognised here ("पेमाइंड", or "Hey Mind" missed entirely)
    // and even if this result arrives after the verdict.
    if ((this.commandsAt.get(identity) ?? []).some((t) => u.speechEndAt <= t + 500 && u.speechStartAt >= t - COMMAND_LOOKBACK_MS)) return;
    const continues = this.wokeUntil.get(identity);
    if (stripWakePhrase(u.text).woke || (continues && u.speechStartAt <= continues)) {
      this.wokeUntil.set(identity, u.speechEndAt + WAKE_CONTINUES_MS);
      return;
    }
    // Recognition can clip "Hey Mind" off the start, so for someone listening for it, wait (briefly) for
    // their browser's assistant to say whether this was a command before translating it.
    const unknownYet = !this.stateKnown.has(identity) && Date.now() - (this.heardSince.get(identity) ?? 0) < UNKNOWN_STATE_MS;
    // Every line waits: live recognition can miss "Hey Mind" entirely ("who is in this call?"), and only the
    // browser's check of the whole clip catches that. (Holding only lines that look like a command was tried
    // on 2026-10-25 and let such commands through to the other callers.)
    if (this.wakeListening.has(identity) || unknownYet) {
      if (DEBUG) console.log(`[interpreter] ${identity} holding "${u.text.slice(0, 30)}" (${unknownYet ? "state unknown" : "Hey Mind on"})`);
      const list = this.held.get(identity) ?? [];
      const item: Held = { u, heldAt: Date.now(), timer: setTimeout(() => this.holdExpired(identity, item), WAKE_HOLD_MS), prepared: this.prepare(identity, u) };
      list.push(item);
      this.held.set(identity, list);
      return;
    }
    await this.translate(identity, u);
  }

  /**
   * The pause that ends a sentence for this person: short (faster translation) unless they may be talking to
   * the assistant, where a short pause splits "Hey Mind, …" commands and lets pieces through.
   */
  private pauseFor(identity: string): { pauseMs: number; phraseMs: number } {
    if (this.wakeListening.has(identity) || !this.stateKnown.has(identity)) return { pauseMs: Math.max(segmenterOptions().endSilenceMs, WAKE_PAUSE_MS), phraseMs: 0 };
    // Phrase by phrase: translation starts at each short breath, not only when the speaker stops.
    if (phraseMode()) return { pauseMs: process.env.INTERPRETER_PAUSE_MS ? segmenterOptions().endSilenceMs : PHRASE_PAUSE_MS, phraseMs: PHRASE_MAX_MS };
    return { pauseMs: segmenterOptions().endSilenceMs, phraseMs: 0 };
  }

  /** A held line's wait is over: keep waiting if the browser is still checking a clip (slow recognition), else translate. */
  private holdExpired(identity: string, item: Held) {
    const checking = this.checkingSince.get(identity);
    const now = Date.now();
    if (checking && now - checking < CHECK_MAX_MS && now - item.heldAt < CHECK_MAX_MS) {
      item.timer = setTimeout(() => this.holdExpired(identity, item), 500);
      return;
    }
    this.release(identity, true, item);
  }

  /** Translate (or drop) what a person said while we waited for the assistant's verdict. */
  private release(identity: string, translate: boolean, only?: Held) {
    const list = this.held.get(identity) ?? [];
    const take = only ? list.filter((x) => x === only) : list;
    this.held.set(identity, only ? list.filter((x) => x !== only) : []);
    if (DEBUG && take.length) console.log(`[interpreter] ${identity} ${translate ? "translating" : "dropping"} ${take.length} held${only ? " (timeout)" : ""}`);
    for (const x of take) {
      clearTimeout(x.timer);
      if (translate) void this.translate(identity, x.u, x.prepared);
    }
  }

  /** Languages this person's speech goes to: everyone else's in the call. */
  private targetsFor(identity: string) {
    if (!this.interpreting) return []; // transcription only: no translation, no voice
    return [...new Set([...this.presentLanguages().entries()].filter(([id]) => id !== identity).map(([, l]) => l))];
  }

  /**
   * While a sentence waits for the "Hey Mind" verdict, translate it already (nothing is shown, stored or
   * played), so when it turns out to be ordinary speech the listeners' voices can start at once.
   */
  private prepare(identity: string, u: Utt) {
    const prepared = new Map<string, Promise<string | null>>();
    for (const lang of this.targetsFor(identity)) if (lang !== u.language) prepared.set(lang, prepareTranslation(u.text, u.language, lang));
    return prepared;
  }

  private async translate(identity: string, u: Utt, prepared?: Map<string, Promise<string | null>>) {
    const person = this.people.get(identity);
    if (!person?.consent) return;
    // Too old to voice (a stalled recogniser catching up): transcript only, no translation or voice.
    const stale = isStale(u);
    if (stale) console.warn(`[interpreter] ${identity}: recognised ${Math.round((u.resultAt - u.speechEndAt) / 1000)} s late (${Math.round((u.speechEndAt - u.speechStartAt) / 1000)} s of speech): transcript only, not voiced`);
    const targets = stale ? [] : this.targetsFor(identity);
    const out: InterpreterOutput = {
      speak: (language, text) => this.speakIn(language, text, person.voice),
      send: (msg) => this.send(msg),
    };
    try {
      // The phrases this speaker said in the last few seconds: the new one continues them.
      const before = (this.recent.get(identity) ?? []).filter((r) => u.speechStartAt - r.endAt < CONTEXT_GAP_MS).slice(-CONTEXT_PHRASES);
      const context = new Map<string, PhraseContext>();
      for (const lang of targets) {
        const withIt = before.filter((r) => r.translations.has(lang));
        if (withIt.length) context.set(lang, { source: withIt.map((r) => r.text).join(" "), translated: withIt.map((r) => r.translations.get(lang)).join(" ") });
      }
      const mine = { text: u.text, endAt: u.speechEndAt, translations: new Map<string, string>() };
      this.recent.set(identity, [...before, mine].slice(-CONTEXT_PHRASES));
      await interpretUtterance({
        meeting: { id: this.meeting.id, startedAt: this.startedAt },
        speaker: { userId: identity, label: person.label },
        utt: u,
        targetLanguages: targets,
        out,
        prepared,
        context: context.size ? context : undefined,
        onTranslated: (lang, text) => mine.translations.set(lang, text),
      });
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
