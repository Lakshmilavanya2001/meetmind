"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckCircle2, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";

/** Verify the mobile number by SMS code; then choose whether reminders are texted by default. */
export function PhoneCard({ available, phone, verified, smsReminders }: { available: boolean; phone: string | null; verified: boolean; smsReminders: boolean }) {
  const router = useRouter();
  const [sent, setSent] = useState<null | "twilio" | "outbox">(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(smsReminders);

  async function send() {
    setBusy(true);
    try {
      const r = await api<{ provider: "twilio" | "outbox" }>("/api/profile/phone/verify/start", { method: "POST" });
      setSent(r.provider);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send the code");
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/profile/phone/verify", { method: "POST", json: { code } });
      toast.success("Mobile number verified");
      setSent(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't verify");
    } finally {
      setBusy(false);
    }
  }
  async function toggle(next: boolean) {
    setOn(next);
    try {
      await api("/api/profile/sms-reminders", { method: "PUT", json: { enabled: next } });
    } catch (err) {
      setOn(!next);
      toast.error(err instanceof Error ? err.message : "Couldn't change the setting");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Smartphone className="size-4" aria-hidden /> SMS reminders</CardTitle>
        <CardDescription>
          Reminders and action items can be texted to your own mobile number once it&apos;s verified. MeetMind never texts anyone else.{" "}
          <Link href="/settings/messages" className="underline underline-offset-2">Text messages sent to you</Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!available ? (
          <p className="text-sm text-muted-foreground">Text messages aren&apos;t set up on this server, so SMS reminders are unavailable. Reminders still appear in your notifications.</p>
        ) : !phone ? (
          <p className="text-sm text-muted-foreground">Add your mobile number above first.</p>
        ) : verified ? (
          <>
            <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> {phone} is verified.</p>
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="sms-default" className="font-normal">Text me reminders by default (including action items assigned to me)</Label>
              <Switch id="sms-default" checked={on} onCheckedChange={toggle} />
            </div>
          </>
        ) : sent ? (
          <form onSubmit={verify} className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="sms-code">Enter the 6-digit code sent to {phone}</Label>
            {sent === "outbox" && (
              <p className="text-xs text-muted-foreground">
                SMS isn&apos;t connected on this server (no Twilio account), so the code is in your <Link href="/settings/messages" className="underline">text messages outbox</Link>.
              </p>
            )}
            <div className="flex gap-2">
              <Input id="sms-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <Button type="submit" disabled={busy || code.length !== 6}>{busy && <Loader2 className="animate-spin" aria-hidden />} Verify</Button>
            </div>
          </form>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">{phone} isn&apos;t verified yet.</p>
            <Button onClick={send} disabled={busy}>{busy && <Loader2 className="animate-spin" aria-hidden />} Send code</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** How call summaries reach you: always in the app; email and SMS are your choice. */
export function SummaryPrefsCard({ email, sms, smsPossible }: { email: boolean; sms: boolean; smsPossible: boolean }) {
  const [v, setV] = useState({ email, sms });
  async function save(next: { email: boolean; sms: boolean }) {
    const prev = v;
    setV(next);
    try {
      await api("/api/profile/summary-delivery", { method: "PUT", json: next });
    } catch (err) {
      setV(prev);
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Call summaries</CardTitle>
        <CardDescription>After each call you were in, the AI summary (key points, decisions, action items) is sent to you. It always appears in the app.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="sum-email" className="font-normal">Email me call summaries</Label>
          <Switch id="sum-email" checked={v.email} onCheckedChange={(c) => save({ ...v, email: c })} />
        </div>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="sum-sms" className="font-normal">Text me call summaries{!smsPossible && " (verify your mobile number first)"}</Label>
          <Switch id="sum-sms" checked={v.sms} disabled={!smsPossible && !v.sms} onCheckedChange={(c) => save({ ...v, sms: c })} />
        </div>
      </CardContent>
    </Card>
  );
}
