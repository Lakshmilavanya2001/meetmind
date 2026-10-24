"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormField } from "@/components/form-field";
import { api, ApiError } from "@/lib/api";

export function AcceptInvitation({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function accept() {
    setPending(true);
    setError(null);
    try {
      const res = await api<{ joinCode: string }>(`/api/invite/${token}/accept`, { method: "POST" });
      router.replace(`/meetings/${res.joinCode}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept");
      setPending(false);
    }
  }
  return (
    <>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <Button onClick={accept} disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Accept invitation</Button>
    </>
  );
}

export function GuestSignupForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setFields({});
    try {
      const res = await api<{ joinCode: string }>(`/api/invite/${token}/signup`, {
        method: "POST",
        json: { displayName: f.get("displayName"), password: f.get("password") },
      });
      router.replace(`/meetings/${res.joinCode}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields ?? {});
      } else setError("Could not reach the server.");
      setPending(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <p className="text-sm text-muted-foreground">Create a guest account to join. Guests can only see meetings they&apos;re invited to.</p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <FormField id="g-email" label="Email">
        <Input id="g-email" value={email} readOnly disabled />
      </FormField>
      <FormField id="g-name" label="Your name" error={fields.displayName}>
        <Input id="g-name" name="displayName" autoComplete="name" required autoFocus />
      </FormField>
      <FormField id="g-pw" label="Password" error={fields.password} hint="At least 10 characters.">
        <Input id="g-pw" name="password" type="password" autoComplete="new-password" required minLength={10} />
      </FormField>
      <Button type="submit" disabled={pending}>{pending && <Loader2 className="animate-spin" aria-hidden />} Create guest account & accept</Button>
    </form>
  );
}
