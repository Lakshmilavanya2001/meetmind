"use client";

import { useCallback, useEffect, useState } from "react";
import { useParticipants } from "@livekit/components-react";
import { Track } from "livekit-client";
import { Mic, MicOff, MoreVertical, MonitorUp, UserPlus, VideoOff } from "lucide-react";
import { InviteDialog } from "@/components/meetings/meeting-actions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import type { MeetingRole } from "./types";

type ServerParticipant = { userId: string; role: MeetingRole; email: string | null };

const ROLE_LABEL: Record<MeetingRole, string> = { HOST: "Host", COHOST: "Co-host", ATTENDEE: "" };

export function ParticipantsPanel({
  meetingRef,
  meId,
  myRole,
  onMyRole,
}: {
  meetingRef: string;
  meId: string;
  myRole: MeetingRole;
  onMyRole: (r: MeetingRole) => void;
}) {
  // Live presence and media state come from the LiveKit client; roles come from our server (the source of truth).
  const participants = useParticipants();
  const [roles, setRoles] = useState<Map<string, ServerParticipant>>(new Map());
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
  const isModerator = myRole === "HOST" || myRole === "COHOST";

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ participants: ServerParticipant[] }>(`/api/meetings/${meetingRef}/participants`);
      setRoles(new Map(res.participants.map((p) => [p.userId, p])));
      const mine = res.participants.find((p) => p.userId === meId);
      if (mine) onMyRole(mine.role);
    } catch {
      /* keep last known roles; the panel still shows live presence */
    }
  }, [meetingRef, meId, onMyRole]);

  const count = participants.length;
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 10_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, count]);

  async function act(path: string, init: Parameters<typeof api>[1], success: string) {
    try {
      await api(path, init);
      toast.success(success);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    }
  }

  return (
    <>
      {isModerator && (
        <div className="border-b border-white/10 p-3">
          <InviteDialog
            meetingRef={meetingRef}
            existingIds={participants.map((p) => p.identity)}
            trigger={
              <Button variant="secondary" size="sm" className="w-full">
                <UserPlus aria-hidden /> Invite people
              </Button>
            }
          />
        </div>
      )}
      <ul className="divide-y divide-white/10">
        {participants.map((p) => {
          const info = roles.get(p.identity);
          const role = info?.role ?? "ATTENDEE";
          const micOn = p.isMicrophoneEnabled;
          const camOn = p.isCameraEnabled;
          const sharing = p.getTrackPublication(Track.Source.ScreenShare) !== undefined;
          const isMe = p.identity === meId;
          const name = p.name || p.identity;
          const isAgent = p.identity === "agent-interpreter";
          const canAct = isModerator && !isMe && !isAgent && role !== "HOST" && !(role === "COHOST" && myRole !== "HOST");
          return (
            <li key={p.identity} className="flex items-center gap-3 px-4 py-3">
              <Avatar className="size-8">
                <AvatarFallback className="bg-white/10 text-xs text-white">{initials(name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {name} {isMe && <span className="text-white/50">(you)</span>}
                </p>
                {isAgent && <p className="truncate text-xs text-violet-200/80">AI · turn it off from the interpreter menu</p>}
                {!isAgent && (ROLE_LABEL[role] || info?.email) && (
                  <p className="truncate text-xs text-white/50">{[ROLE_LABEL[role], info?.email].filter(Boolean).join(" · ")}</p>
                )}
              </div>
              <span className="flex items-center gap-1.5 text-white/60">
                {sharing && <MonitorUp className="size-4" aria-label="Sharing screen" />}
                {!camOn && <VideoOff className="size-4" aria-label="Camera off" />}
                {micOn ? <Mic className="size-4" aria-label="Microphone on" /> : <MicOff className="size-4 text-red-400" aria-label="Muted" />}
              </span>
              {canAct && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10" aria-label={`Actions for ${name}`}>
                      <MoreVertical />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={!micOn} onSelect={() => act(`/api/meetings/${meetingRef}/participants/${p.identity}/mute`, { method: "POST" }, `${name} was muted`)}>
                      Mute microphone
                    </DropdownMenuItem>
                    {myRole === "HOST" && (
                      <DropdownMenuItem
                        onSelect={() =>
                          act(`/api/meetings/${meetingRef}/participants/${p.identity}`, { method: "PATCH", json: { role: role === "COHOST" ? "ATTENDEE" : "COHOST" } },
                            role === "COHOST" ? `${name} is no longer a co-host` : `${name} is now a co-host`)
                        }
                      >
                        {role === "COHOST" ? "Remove co-host" : "Make co-host"}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove({ id: p.identity, name })}>
                      Remove from meeting
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          );
        })}
      </ul>

      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmRemove?.name}?</AlertDialogTitle>
            <AlertDialogDescription>They will be disconnected and won&apos;t be able to rejoin this meeting.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => confirmRemove && act(`/api/meetings/${meetingRef}/participants/${confirmRemove.id}`, { method: "DELETE" }, `${confirmRemove.name} was removed`)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
