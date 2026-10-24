import "server-only";
import type { MeetingProvider } from "@/generated/prisma/enums";
import { createLiveKitProvider } from "./livekit";
import { createTeamsProvider } from "./teams";
import type { CallingProvider } from "./types";

export type { CallingProvider } from "./types";

let overrides: Partial<Record<MeetingProvider, CallingProvider>> = {};
const instances: Partial<Record<MeetingProvider, CallingProvider>> = {};

export function getCallingProvider(provider: MeetingProvider = "LIVEKIT"): CallingProvider {
  if (overrides[provider]) return overrides[provider]!;
  return (instances[provider] ??= provider === "LIVEKIT" ? createLiveKitProvider() : createTeamsProvider());
}

/** Test hook: substitute a fake provider. */
export function setCallingProviderForTests(provider: MeetingProvider, impl: CallingProvider | null) {
  if (impl) overrides[provider] = impl;
  else overrides = {};
}
