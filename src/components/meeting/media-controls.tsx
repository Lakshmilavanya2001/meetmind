"use client";

import { MediaDeviceMenu, TrackToggle, useLocalParticipant } from "@livekit/components-react";
import { Track } from "livekit-client";
import { toast } from "sonner";
import { Key } from "./phone-key";

const onError = (what: string) => (e: Error) =>
  toast.error(e.name === "NotAllowedError" ? `Permission to use your ${what} was denied.` : `Could not start ${what}: ${e.message}`);

// LiveKit's TrackToggle/MediaDeviceMenu with explicit, state-aware accessible names, laid out as phone keys.
export function MicKey() {
  const { isMicrophoneEnabled } = useLocalParticipant();
  return (
    <Key label={isMicrophoneEnabled ? "Mute" : "Unmute"}>
      <div className="relative">
        <TrackToggle
          source={Track.Source.Microphone}
          aria-label={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
          title={isMicrophoneEnabled ? "Mute microphone" : "Unmute microphone"}
          onDeviceError={onError("microphone")}
        />
        <div className="phone-key-sub">
          <MediaDeviceMenu kind="audioinput" aria-label="Choose microphone" title="Choose microphone" />
        </div>
      </div>
    </Key>
  );
}

export function CameraKey() {
  const { isCameraEnabled } = useLocalParticipant();
  return (
    <Key label="Camera">
      <div className="relative">
        <TrackToggle
          source={Track.Source.Camera}
          aria-label={isCameraEnabled ? "Turn camera off" : "Turn camera on"}
          title={isCameraEnabled ? "Turn camera off" : "Turn camera on"}
          onDeviceError={onError("camera")}
        />
        <div className="phone-key-sub">
          <MediaDeviceMenu kind="videoinput" aria-label="Choose camera" title="Choose camera" />
        </div>
      </div>
    </Key>
  );
}

export function ShareKey({ small }: { small?: boolean }) {
  const { isScreenShareEnabled } = useLocalParticipant();
  return (
    <Key label={isScreenShareEnabled ? "Stop sharing" : "Share"} small={small}>
      <TrackToggle
        source={Track.Source.ScreenShare}
        captureOptions={{ audio: true, selfBrowserSurface: "exclude" }}
        aria-label={isScreenShareEnabled ? "Stop presenting" : "Share screen"}
        title={isScreenShareEnabled ? "Stop presenting" : "Share screen"}
        onDeviceError={onError("screen sharing")}
      />
    </Key>
  );
}
