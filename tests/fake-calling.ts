import { vi } from "vitest";
import type { CallingProvider, LiveParticipant } from "@/server/providers/calling/types";
import { AppError } from "@/server/errors";

/** In-memory calling provider for service tests. Never used by the running app. */
export function createFakeCallingProvider() {
  const rooms = new Map<string, Map<string, LiveParticipant>>();
  let failing = false;
  const guard = () => {
    if (failing) throw new AppError("PROVIDER_UNAVAILABLE", "The calling service is unavailable right now. Please try again.");
  };
  const provider: CallingProvider & {
    connect(roomId: string, identity: string, opts?: Partial<LiveParticipant>): void;
    setFailing(v: boolean): void;
    rooms: typeof rooms;
  } = {
    id: "LIVEKIT",
    capabilities: { issueJoinCredentials: true, listParticipants: true, removeParticipant: true, muteParticipant: true, endMeeting: true, nativeTranscription: false, recording: false },
    isConfigured: () => true,
    ensureRoom: vi.fn(async (roomId: string) => {
      guard();
      if (!rooms.has(roomId)) rooms.set(roomId, new Map());
      return { roomId, createdAt: new Date("2026-01-01T10:00:00Z") };
    }),
    issueJoinCredentials: vi.fn(async (grant, { publicUrl }) => {
      guard();
      return { serverUrl: publicUrl, token: `fake-token:${grant.roomId}:${grant.identity}:${JSON.stringify(grant.metadata)}`, expiresAt: new Date(Date.now() + grant.ttlSeconds * 1000) };
    }),
    listParticipants: vi.fn(async (roomId: string) => [...(rooms.get(roomId)?.values() ?? [])]),
    removeParticipant: vi.fn(async (roomId: string, identity: string) => {
      guard();
      rooms.get(roomId)?.delete(identity);
    }),
    muteParticipantAudio: vi.fn(async (roomId: string, identity: string) => {
      const p = rooms.get(roomId)?.get(identity);
      if (!p?.isPublishingAudio) return false;
      p.isPublishingAudio = false;
      return true;
    }),
    endRoom: vi.fn(async (roomId: string) => {
      rooms.delete(roomId);
    }),
    parseWebhook: vi.fn(async () => null),
    updateRoomMetadata: vi.fn(async () => {}),
    connect(roomId, identity, opts = {}) {
      rooms.get(roomId)?.set(identity, {
        identity, name: identity, joinedAt: new Date(), isPublishingAudio: true, isPublishingVideo: true, isScreenSharing: false, audioTrackSid: "TR_a", ...opts,
      });
    },
    setFailing(v) {
      failing = v;
    },
    rooms,
  };
  return provider;
}
