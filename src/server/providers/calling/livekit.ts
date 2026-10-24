import "server-only";
import { AccessToken, RoomServiceClient, TrackSource, TrackType, WebhookReceiver } from "livekit-server-sdk";
import { AppError } from "../../errors";
import type { CallingEvent, CallingProvider, LiveParticipant } from "./types";

type Config = { url: string; apiKey: string; apiSecret: string };

export function readLiveKitConfig(env: Record<string, string | undefined> = process.env): Config | null {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = env;
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return null;
  return { url: LIVEKIT_URL, apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET };
}

const toHttp = (url: string) => url.replace(/^ws(s?):\/\//, "http$1://");

/** Retry transient network failures against the LiveKit API (idempotent calls only). */
async function withRetry<T>(op: string, fn: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const status = (err as { status?: number }).status;
      const transient = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(msg) || (status !== undefined && status >= 500);
      if (attempt < retries && transient) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      if ((err as { code?: string }).code === "not_found" || status === 404) throw err;
      console.error(`[livekit] ${op} failed`, msg);
      throw new AppError("PROVIDER_UNAVAILABLE", "The calling service is unavailable right now. Please try again.");
    }
  }
}

const isNotFound = (err: unknown) =>
  (err as { status?: number }).status === 404 || /not.?found|does not exist/i.test(String((err as Error)?.message));

export function createLiveKitProvider(config: Config | null = readLiveKitConfig()): CallingProvider {
  const rooms = () => {
    if (!config) throw new AppError("NOT_CONFIGURED", "LiveKit is not configured (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).");
    return new RoomServiceClient(toHttp(config.url), config.apiKey, config.apiSecret);
  };

  return {
    id: "LIVEKIT",
    capabilities: {
      issueJoinCredentials: true,
      listParticipants: true,
      removeParticipant: true,
      muteParticipant: true,
      endMeeting: true,
      nativeTranscription: false, // LiveKit has no built-in STT; we transcribe explicitly (Phase 5)
      recording: false, // requires LiveKit Egress, not deployed here
    },
    isConfigured: () => config !== null,

    async ensureRoom(roomId, opts) {
      // createRoom is idempotent in LiveKit: returns the existing room if present.
      const room = await withRetry("createRoom", () =>
        rooms().createRoom({ name: roomId, emptyTimeout: opts.emptyTimeoutSec ?? 300, maxParticipants: opts.maxParticipants ?? 100 }),
      );
      return { roomId: room.name, createdAt: room.creationTime ? new Date(Number(room.creationTime) * 1000) : undefined };
    },

    async issueJoinCredentials(grant, { publicUrl }) {
      if (!config) throw new AppError("NOT_CONFIGURED", "LiveKit is not configured.");
      const at = new AccessToken(config.apiKey, config.apiSecret, {
        identity: grant.identity,
        name: grant.name,
        metadata: JSON.stringify(grant.metadata),
        ttl: grant.ttlSeconds,
      });
      // Deliberately no roomAdmin: moderation goes through our API, which checks meeting roles.
      at.addGrant({
        room: grant.roomId,
        roomJoin: true,
        canSubscribe: true,
        canPublishData: true,
        canPublish: grant.canPublish,
        canPublishSources: grant.canPublish
          ? grant.canPublishScreen
            ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
            : [TrackSource.MICROPHONE, TrackSource.CAMERA]
          : [],
        canUpdateOwnMetadata: false,
      });
      return {
        serverUrl: publicUrl,
        token: await at.toJwt(),
        expiresAt: new Date(Date.now() + grant.ttlSeconds * 1000),
      };
    },

    async listParticipants(roomId) {
      try {
        const list = await withRetry("listParticipants", () => rooms().listParticipants(roomId));
        return list.map<LiveParticipant>((p) => {
          const audio = p.tracks.find((t) => t.type === TrackType.AUDIO && t.source === TrackSource.MICROPHONE && !t.muted);
          return {
            identity: p.identity,
            name: p.name,
            joinedAt: p.joinedAt ? new Date(Number(p.joinedAt) * 1000) : null,
            isPublishingAudio: !!audio,
            isPublishingVideo: p.tracks.some((t) => t.source === TrackSource.CAMERA && !t.muted),
            isScreenSharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
            audioTrackSid: audio?.sid ?? null,
          };
        });
      } catch (err) {
        if (isNotFound(err)) return []; // room not started / already closed
        throw err;
      }
    },

    async removeParticipant(roomId, identity) {
      try {
        await withRetry("removeParticipant", () => rooms().removeParticipant(roomId, identity));
      } catch (err) {
        if (!isNotFound(err)) throw err; // not connected right now is fine — DB flag still blocks rejoin
      }
    },

    async muteParticipantAudio(roomId, identity) {
      const p = (await this.listParticipants(roomId)).find((x) => x.identity === identity);
      if (!p?.audioTrackSid) return false;
      await withRetry("mutePublishedTrack", () => rooms().mutePublishedTrack(roomId, identity, p.audioTrackSid!, true));
      return true;
    },

    async endRoom(roomId) {
      try {
        await withRetry("deleteRoom", () => rooms().deleteRoom(roomId));
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    },

    async updateRoomMetadata(roomId, metadata) {
      try {
        await withRetry("updateRoomMetadata", () => rooms().updateRoomMetadata(roomId, JSON.stringify(metadata)));
      } catch (err) {
        if (!isNotFound(err)) throw err; // no live room yet — clients read state when they join
      }
    },

    async parseWebhook(body, authHeader) {
      if (!config) throw new AppError("NOT_CONFIGURED", "LiveKit is not configured.");
      const receiver = new WebhookReceiver(config.apiKey, config.apiSecret);
      let event;
      try {
        event = await receiver.receive(body, authHeader ?? undefined);
      } catch {
        throw new AppError("UNAUTHENTICATED", "Invalid webhook signature.");
      }
      const roomId = event.room?.name;
      const at = new Date(Number(event.createdAt ?? Math.floor(Date.now() / 1000)) * 1000);
      if (!roomId) return null;
      const identity = event.participant?.identity;
      switch (event.event) {
        case "participant_joined":
          return identity ? ({ type: "participant_joined", roomId, identity, at } satisfies CallingEvent) : null;
        case "participant_left":
          return identity ? ({ type: "participant_left", roomId, identity, at } satisfies CallingEvent) : null;
        case "room_started":
          return { type: "room_started", roomId, at };
        case "room_finished":
          return { type: "room_finished", roomId, at };
        default:
          return null;
      }
    },
  };
}
