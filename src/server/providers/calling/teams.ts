import "server-only";
import { AppError } from "../../errors";
import type { CallingProvider } from "./types";

/**
 * Microsoft Teams connector — intentionally disabled until credentials exist.
 * See docs/TEAMS_CONNECTOR.md (Phase 7) for the Graph app registration and permissions it will need.
 * Every operation fails loudly with NOT_CONFIGURED; nothing pretends to work.
 */
const notConfigured = async (): Promise<never> => {
  throw new AppError("NOT_CONFIGURED", "The Microsoft Teams connector is not configured.");
};

export function createTeamsProvider(): CallingProvider {
  return {
    id: "MICROSOFT_TEAMS",
    capabilities: {
      issueJoinCredentials: false, // Teams users join through Teams' own client/join URL
      listParticipants: false,
      removeParticipant: false,
      muteParticipant: false,
      endMeeting: false,
      nativeTranscription: false,
      recording: false,
    },
    isConfigured: () => false,
    ensureRoom: notConfigured,
    issueJoinCredentials: notConfigured,
    listParticipants: notConfigured,
    removeParticipant: notConfigured,
    muteParticipantAudio: notConfigured,
    endRoom: notConfigured,
    updateRoomMetadata: notConfigured,
    parseWebhook: notConfigured,
  };
}
