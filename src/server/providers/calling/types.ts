/**
 * Provider-independent calling interface. The meeting service and the AI agent only talk
 * to this interface; LiveKit, Teams, etc. live behind it. Identifiers here are *provider*
 * identifiers (room names, participant identities) and must never be assumed to be portable.
 */

export type CallingCapabilities = {
  /** App can mint join credentials for its own users (LiveKit yes; Teams uses its own join flow). */
  issueJoinCredentials: boolean;
  listParticipants: boolean;
  removeParticipant: boolean;
  muteParticipant: boolean;
  endMeeting: boolean;
  nativeTranscription: boolean;
  recording: boolean;
};

export type ProviderRoom = { roomId: string; createdAt?: Date };

export type LiveParticipant = {
  identity: string; // provider identity; for LiveKit we use our User.id
  name: string;
  joinedAt: Date | null;
  isPublishingAudio: boolean;
  isPublishingVideo: boolean;
  isScreenSharing: boolean;
  audioTrackSid: string | null;
};

export type JoinGrant = {
  roomId: string;
  identity: string;
  name: string;
  metadata: Record<string, unknown>;
  canPublish: boolean;
  canPublishScreen: boolean;
  ttlSeconds: number;
};

export type JoinCredentials = { serverUrl: string; token: string; expiresAt: Date };

export type CallingEvent =
  | { type: "participant_joined"; roomId: string; identity: string; at: Date }
  | { type: "participant_left"; roomId: string; identity: string; at: Date }
  | { type: "room_started"; roomId: string; at: Date }
  | { type: "room_finished"; roomId: string; at: Date };

export interface CallingProvider {
  readonly id: "LIVEKIT" | "MICROSOFT_TEAMS";
  readonly capabilities: CallingCapabilities;
  isConfigured(): boolean;
  ensureRoom(roomId: string, opts: { maxParticipants?: number; emptyTimeoutSec?: number }): Promise<ProviderRoom>;
  issueJoinCredentials(grant: JoinGrant, opts: { publicUrl: string }): Promise<JoinCredentials>;
  listParticipants(roomId: string): Promise<LiveParticipant[]>;
  removeParticipant(roomId: string, identity: string): Promise<void>;
  muteParticipantAudio(roomId: string, identity: string): Promise<boolean>;
  endRoom(roomId: string): Promise<void>;
  /** Room-level state pushed to every connected client instantly (e.g. "transcription is on"). */
  updateRoomMetadata(roomId: string, metadata: Record<string, unknown>): Promise<void>;
  /** Verify and parse a provider webhook. Returns null for events we don't use; throws on bad signatures. */
  parseWebhook(body: string, authHeader: string | null): Promise<CallingEvent | null>;
}
