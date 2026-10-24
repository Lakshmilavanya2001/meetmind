"use client";

import { Chat } from "@livekit/components-react";

// Real-time chat over LiveKit data channels. Messages reach everyone currently in the call;
// they are not stored (persisted meeting chat can be added alongside transcripts later).
export function ChatPanel() {
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-white/10 px-4 py-2 text-xs text-white/60">Messages are visible to people in the call and aren&apos;t saved.</p>
      <Chat className="!h-auto min-h-0 flex-1 !bg-transparent" />
    </div>
  );
}
