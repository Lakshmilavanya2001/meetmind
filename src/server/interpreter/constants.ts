/** Shared by the app and the interpreter process (which loads the native WebRTC SDK; the app must not). */
export const INTERPRETER_IDENTITY = "agent-interpreter";
export const INTERPRETER_NAME = "MeetMind Interpreter";
export const INTERPRETER_TOPIC = "interpreter";
/** Browser → interpreter: { active } while this caller is talking to the voice assistant. */
export const ASSISTANT_STATE_TOPIC = "assistant-state";
/** Safety cap: translation resumes after this long even if the browser never says it's done. */
export const ASSISTANT_MAX_MS = 60_000;
export const interpreterTrackName = (language: string) => `interpreter-${language}`;
/**
 * Languages people can speak and hear in calls: the 12 that both NVIDIA Parakeet (speech recognition)
 * and Magpie (voice) support. The Indic models are no longer used for calls (2026-10-24).
 */
export const CALL_LANGUAGES = ["en", "hi", "es", "fr", "de", "it", "pt", "zh", "ja", "ko", "ar", "vi"] as const;
/** @deprecated kept for older imports */
export const BASE_INTERPRETER_LANGUAGES = CALL_LANGUAGES;
/** Every language the interpreter could support (for validation). */
export const ALL_INTERPRETER_LANGUAGES: string[] = [...CALL_LANGUAGES];
/** Languages available in calls now. */
export const interpreterLanguageCodes = (): string[] => [...CALL_LANGUAGES];
/** @deprecated use interpreterLanguageCodes() */
export const INTERPRETER_LANGUAGES = CALL_LANGUAGES;
export type InterpreterLanguage = string;
