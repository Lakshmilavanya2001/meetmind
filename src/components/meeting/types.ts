export type MeetingRole = "HOST" | "COHOST" | "ATTENDEE";

export type MeetingInfo = {
  id: string;
  title: string;
  joinCode: string;
  status: "SCHEDULED" | "LIVE" | "ENDED" | "CANCELED";
  hostName: string;
  transcriptionEnabled: boolean;
  recordingEnabled: boolean;
  callType: "VIDEO" | "VOICE";
  isDirectCall: boolean;
};

export type Me = { id: string; displayName: string; role: MeetingRole; language: string };

export type JoinResponse = {
  serverUrl: string;
  token: string;
  myRole: MeetingRole;
  sessionStartedAt: string;
};

export type DeviceChoices = { audioEnabled: boolean; videoEnabled: boolean };
