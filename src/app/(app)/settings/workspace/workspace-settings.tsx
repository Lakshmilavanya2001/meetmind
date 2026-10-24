"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { FormField } from "@/components/form-field";
import { api } from "@/lib/api";

type Workspace = {
  name: string;
  memberCount: number;
  joinCode: string | null;
  allowExternalInvites: boolean;
  agentAutoExecute: boolean;
  transcriptRetentionDays: number | null;
  recordingRetentionDays: number | null;
};

const toDays = (v: string) => (v.trim() === "" ? null : Number(v));

export function WorkspaceSettings({ workspace, canEdit }: { workspace: Workspace; canEdit: boolean }) {
  const router = useRouter();
  const [v, setV] = useState({
    name: workspace.name,
    allowExternalInvites: workspace.allowExternalInvites,
    agentAutoExecute: workspace.agentAutoExecute,
    transcriptRetentionDays: workspace.transcriptRetentionDays?.toString() ?? "",
    recordingRetentionDays: workspace.recordingRetentionDays?.toString() ?? "",
  });
  const [joinCode, setJoinCode] = useState(workspace.joinCode);
  const [pending, setPending] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      await api("/api/workspace", {
        method: "PATCH",
        json: {
          name: v.name,
          allowExternalInvites: v.allowExternalInvites,
          agentAutoExecute: v.agentAutoExecute,
          transcriptRetentionDays: toDays(v.transcriptRetentionDays),
          recordingRetentionDays: toDays(v.recordingRetentionDays),
        },
      });
      toast.success("Workspace settings saved");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setPending(false);
    }
  }

  async function regenerate() {
    try {
      const res = await api<{ joinCode: string }>("/api/workspace/join-code", { method: "POST" });
      setJoinCode(res.joinCode);
      toast.success("New join code created. The old code no longer works.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not regenerate code");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Settings</CardTitle>
        <CardDescription>{workspace.memberCount} members</CardDescription>
      </CardHeader>
      <form onSubmit={save}>
        <CardContent className="grid gap-5">
          <FormField id="ws-name" label="Workspace name">
            <Input id="ws-name" value={v.name} disabled={!canEdit} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </FormField>

          {joinCode && (
            <div className="grid gap-1.5">
              <Label htmlFor="join-code">Join code</Label>
              <div className="flex gap-2">
                <Input id="join-code" value={joinCode} readOnly className="max-w-56 font-mono" />
                <Button type="button" variant="outline" size="icon" aria-label="Copy join code"
                  onClick={() => navigator.clipboard.writeText(joinCode).then(() => toast.success("Copied"), () => toast.error("Copy failed"))}>
                  <Copy />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="outline"><RefreshCw /> Regenerate</Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Regenerate join code?</AlertDialogTitle>
                      <AlertDialogDescription>The current code stops working immediately. Existing members are not affected.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={regenerate}>Regenerate</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <p className="text-xs text-muted-foreground">Anyone with this code can create an account in this workspace.</p>
            </div>
          )}

          <Separator />
          <ToggleRow id="ext" label="Allow email invitations to unregistered people"
            description="When off, meetings can only include workspace members."
            checked={v.allowExternalInvites} disabled={!canEdit} onChange={(c) => setV({ ...v, allowExternalInvites: c })} />
          <ToggleRow id="auto" label="Let the AI assistant run sensitive actions without asking"
            description="When off (recommended), cancelling meetings and removing participants always need your confirmation."
            checked={v.agentAutoExecute} disabled={!canEdit} onChange={(c) => setV({ ...v, agentAutoExecute: c })} />
          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="tr" label="Transcript retention (days)" hint="Blank keeps transcripts until deleted.">
              <Input id="tr" type="number" min={1} max={3650} value={v.transcriptRetentionDays} disabled={!canEdit}
                onChange={(e) => setV({ ...v, transcriptRetentionDays: e.target.value })} />
            </FormField>
            <FormField id="rr" label="Recording retention (days)" hint="Blank keeps recordings until deleted.">
              <Input id="rr" type="number" min={1} max={3650} value={v.recordingRetentionDays} disabled={!canEdit}
                onChange={(e) => setV({ ...v, recordingRetentionDays: e.target.value })} />
            </FormField>
          </div>
        </CardContent>
        {canEdit && (
          <CardFooter className="mt-6 justify-end">
            <Button type="submit" disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Save settings</Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}

function ToggleRow(props: { id: string; label: string; description: string; checked: boolean; disabled: boolean; onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor={props.id}>{props.label}</Label>
        <p className="mt-1 text-xs text-muted-foreground">{props.description}</p>
      </div>
      <Switch id={props.id} checked={props.checked} disabled={props.disabled} onCheckedChange={props.onChange} />
    </div>
  );
}
