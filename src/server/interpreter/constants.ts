/** Shared by the app and the interpreter process (which loads the native WebRTC SDK; the app must not). */
export const INTERPRETER_IDENTITY = "agent-interpreter";
export const INTERPRETER_NAME = "MeetMind Interpreter";
export const INTERPRETER_TOPIC = "interpreter";
/** Browser → interpreter: { active } while this caller is talking to the voice assistant. */
export const ASSISTANT_STATE_TOPIC = "assistant-state";
/** Safety cap: translation resumes after this long even if the browser never says it's done. */
export const ASSISTANT_MAX_MS = 60_000;
export const interpreterTrackName = (language: string) => `interpreter-${language}`;
import { INDIC_LANGS, readIndicConfig } from "../providers/indic";

/** Always available: English and Spanish (Riva) and Hindi (Riva, or IndicConformer when connected). */
export const BASE_INTERPRETER_LANGUAGES = ["en", "hi", "es"] as const;
/** Every language the interpreter could support (for validation). */
export const ALL_INTERPRETER_LANGUAGES = [...new Set([...BASE_INTERPRETER_LANGUAGES, ...INDIC_LANGS])];
/** Languages available now: the 22 Indic languages join when IndicConformer is configured. */
export const interpreterLanguageCodes = (): string[] => (readIndicConfig().asr ? ["en", ...INDIC_LANGS, "es"] : [...BASE_INTERPRETER_LANGUAGES]);
/** @deprecated use interpreterLanguageCodes() */
export const INTERPRETER_LANGUAGES = BASE_INTERPRETER_LANGUAGES;
export type InterpreterLanguage = string;
