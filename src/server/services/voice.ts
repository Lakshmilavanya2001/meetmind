import "server-only";
import { z } from "zod";
import { db } from "../db";
import { AppError } from "../errors";
import { audit } from "../audit";
import type { AuthContext } from "../auth/session";
import { getSttProvider } from "../providers/stt";
import { getTtsProvider, toSpeech } from "../providers/tts";
import { decideAction, runAgentTurn, type AgentEvent } from "../ai/agent";
import { getAccessibleMeeting } from "./meetings";
import { classifyYesNo, stripWakePhrase } from "@/lib/voice-commands";
import { indicCovers, indicTranslate, readIndicConfig } from "../providers/indic";
import { magpieCovers, readMagpieConfig } from "../providers/magpie";
import { translateText } from "./translation";
import { interpreterLanguageCodes } from "../interpreter/constants";

type Ctx = Pick<AuthContext, "userId" | "organizationId" | "orgRole" | "user">;

// "Hey Mind" and yes/no detection work in every supported script (see src/lib/voice-commands.ts).
export { classifyYesNo, stripWakePhrase } from "@/lib/voice-commands";

export const utteranceSchema = z.object({
  meetingRef: z.string().min(1).max(300),
  mode: z.enum(["wake", "ptt", "confirm"]),
  conversationId: z.string().max(64).optional(),
  actionId: z.string().max(64).optional(),
  // "1": the browser streams the reply's speech itself (sentence by sentence), so don't synthesise it here.
  streamSpeech: z.enum(["0", "1"]).optional(),
});

export type VoiceReply = {
  heard: string;
  triggered: boolean;
  conversationId?: string;
  reply?: string;
  /** stream: the browser should fetch the speech itself, streamed (no audio is included). */
  speech?: { text: string; language: string; audioBase64?: string; mimeType?: string; stream?: boolean };
  confirmation?: { actionId: string; summary: string };
  /** The next utterance should be treated as the command (after a bare "Hey Mind"). */
  expectCommand?: boolean;
  link?: string;
};

/** App-written text (confirmation summaries, fixed phrases) in the speaker's language. Falls back to English. */
async function inLanguage(text: string, language: string) {
  if (language === "en" || !text) return text;
  if (readIndicConfig().translate && indicCovers(language)) {
    try {
      const [t] = await indicTranslate([text], language);
      if (t) return t;
    } catch {
      /* fall through to the LLM */
    }
  }
  return translateText(text, language);
}

async function speak(text: string, language: string, stream = false): Promise<VoiceReply["speech"]> {
  const spoken = toSpeech(text);
  // Streamed by the browser: the reply goes back at once instead of after the whole audio is generated.
  if (stream && ((readMagpieConfig() && magpieCovers(language)) || (readIndicConfig().tts && indicCovers(language)))) return { text: spoken, language, stream: true };
  try {
    const out = await getTtsProvider()?.synthesize(spoken, { language });
    if (out) return { text: spoken, language, audioBase64: out.audio.toString("base64"), mimeType: out.mimeType };
  } catch (err) {
    console.warn("[voice] TTS failed; the browser voice will be used:", (err as Error).message);
  }
  return { text: spoken, language }; // client falls back to the browser's speech synthesis
}

/**
 * One spoken utterance from the user's own microphone during a call.
 * - wake: only acted on if it starts with "Hey Mind"; anything else is discarded without being stored.
 * - ptt: push-to-talk, the whole utterance is the command.
 * - confirm: a spoken yes/no for the pending action the assistant just proposed.
 */
export async function handleUtterance(
  ctx: Ctx,
  raw: unknown,
  audio: { data: Buffer; mimeType: string },
  /** Called as soon as we know whether this was addressed to the assistant (before the agent runs). */
  onHeard?: (h: { heard: string; triggered: boolean }) => void,
): Promise<VoiceReply> {
  const input = utteranceSchema.parse(raw);
  const stream = input.streamSpeech === "1";
  const { meeting, me } = await (async () => {
    const r = await getAccessibleMeeting(ctx, input.meetingRef);
    return { meeting: r.meeting, me: r.meeting.participants.find((p) => p.userId === ctx.userId) };
  })();
  if (meeting.status !== "LIVE") throw new AppError("CONFLICT", "The voice assistant works during a live call.");
  if (!me || me.removedAt) throw new AppError("FORBIDDEN", "Join the call first.");

  // Listen and answer in the language this person picked for the call (the interpreter menu);
  // otherwise their profile language.
  const user = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { preferredLanguage: true } });
  const picked = me.callLanguage && interpreterLanguageCodes().includes(me.callLanguage) ? me.callLanguage : null;
  const language = picked ?? user.preferredLanguage;
  const { text: heardRaw } = await getSttProvider().transcribe(audio.data, { mimeType: audio.mimeType, language });
  const heard = heardRaw.trim();
  if (!heard) {
    onHeard?.({ heard: "", triggered: false });
    return { heard: "", triggered: false };
  }
  onHeard?.({ heard, triggered: input.mode !== "wake" || stripWakePhrase(heard).woke });

  if (input.mode === "confirm") {
    if (!input.actionId) throw new AppError("VALIDATION", "Missing action.");
    const verdict = classifyYesNo(heard);
    if (!verdict) return { heard, triggered: true, speech: await speak(await inLanguage("Sorry, please say yes or no.", language), language, stream), confirmation: undefined, conversationId: input.conversationId };
    const res = await decideAction(ctx, input.actionId, verdict === "yes" ? "confirm" : "reject");
    await audit({ action: "voice.confirmation", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { verdict } });
    return { heard, triggered: true, conversationId: input.conversationId, reply: res.message.content, speech: await speak(await inLanguage(res.message.content.replace(/[✓*]/g, ""), language), language, stream), link: res.message.link };
  }

  const { woke, command } = stripWakePhrase(heard);
  // Not addressed to the assistant: drop it. Nothing about it is stored or logged.
  if (input.mode === "wake" && !woke) return { heard: "", triggered: false };
  if (!command) return { heard, triggered: true, expectCommand: true, speech: await speak(await inLanguage("Yes? What can I do?", language), language, stream), conversationId: input.conversationId };

  const events: AgentEvent[] = [];
  let reply = "";
  const { conversationId } = await runAgentTurn(ctx, { conversationId: input.conversationId, message: command, meetingRef: meeting.joinCode, channel: "voice", language }, (e) => {
    events.push(e);
    if (e.type === "delta") reply += e.text;
  });
  const confirmations = events.filter((e): e is Extract<AgentEvent, { type: "confirmation" }> => e.type === "confirmation");
  const guard = events.find((e): e is Extract<AgentEvent, { type: "guard" }> => e.type === "guard");
  const failed = events.find((e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error");
  let say = reply.replace(/Please confirm the action\(s\) above — nothing has been changed yet\.?/g, "").trim();
  if (guard) say = await inLanguage(guard.message, language);
  if (failed) say = await inLanguage(failed.message, language);
  const first = confirmations[0];
  if (first) say = `${say ? `${say} ` : ""}${await inLanguage(`${first.summary}. Say yes to confirm, or no to cancel.`, language)}`;
  if (!say) say = await inLanguage("Done.", language);
  await audit({ action: "voice.command", actorUserId: ctx.userId, organizationId: ctx.organizationId, targetType: "Meeting", targetId: meeting.id, metadata: { mode: input.mode, chars: command.length } });
  return {
    heard: command,
    triggered: true,
    conversationId,
    reply: say,
    speech: await speak(say, language, stream),
    confirmation: first ? { actionId: first.actionId, summary: first.summary } : undefined,
  };
}

const ANNOUNCEMENTS: Record<string, string> = {
  en: "This call is now being transcribed.",
  hi: "इस कॉल को अब ट्रांसक्राइब किया जा रहा है।",
};

/** The spoken disclosure played to everyone when transcription starts (in the listener's language). */
export async function transcriptionAnnouncement(language: string) {
  const lang = ANNOUNCEMENTS[language] ? language : "en";
  return speak(ANNOUNCEMENTS[lang], lang);
}
