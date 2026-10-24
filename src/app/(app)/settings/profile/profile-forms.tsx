"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import { api, ApiError } from "@/lib/api";
import { LANGUAGES } from "@/lib/validation";

type Profile = { displayName: string; email: string; title: string; department: string; timezone: string; preferredLanguage: string; phoneNumber: string; phoneVerified: boolean };

export function ProfileForm({ initial }: { initial: Profile }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);

  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFields({});
    try {
      await api("/api/profile", {
        method: "PATCH",
        json: {
          displayName: values.displayName,
          title: values.title || null,
          department: values.department || null,
          timezone: values.timezone,
          preferredLanguage: values.preferredLanguage,
          phoneNumber: values.phoneNumber.trim() || null,
        },
      });
      toast.success("Profile saved");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields ?? {});
      toast.error(err instanceof Error ? err.message : "Could not save profile");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Personal details</CardTitle>
        <CardDescription>Your email ({initial.email}) identifies you uniquely and cannot be changed here.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <FormField id="displayName" label="Display name" error={fields.displayName}>
            <Input id="displayName" value={values.displayName} onChange={set("displayName")} required />
          </FormField>
          <FormField id="timezone" label="Time zone" error={fields.timezone}>
            <select
              id="timezone"
              value={values.timezone}
              onChange={set("timezone")}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30"
            >
              {!zones.includes(values.timezone) && <option value={values.timezone}>{values.timezone}</option>}
              {zones.map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </FormField>
          <FormField id="title" label="Job title" error={fields.title}>
            <Input id="title" value={values.title} onChange={set("title")} placeholder="e.g. Backend Engineer" />
          </FormField>
          <FormField id="department" label="Department" error={fields.department}>
            <Input id="department" value={values.department} onChange={set("department")} placeholder="e.g. Platform" />
          </FormField>
          <FormField id="preferredLanguage" label="Preferred language" error={fields.preferredLanguage} hint="Used by the assistant and for translated captions.">
            <select
              id="preferredLanguage"
              value={values.preferredLanguage}
              onChange={set("preferredLanguage")}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30"
            >
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            </select>
          </FormField>
          <FormField id="phoneNumber" label="Mobile number" error={fields.phoneNumber} hint={initial.phoneNumber && initial.phoneVerified ? "Verified" : "International format, e.g. +919812345678. Used for SMS reminders once verified."}>
            <Input id="phoneNumber" type="tel" autoComplete="tel" value={values.phoneNumber} onChange={set("phoneNumber")} placeholder="+91…" />
          </FormField>
        </CardContent>
        <CardFooter className="mt-6 justify-end">
          <Button type="submit" disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />} Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function PasswordForm() {
  const [pending, setPending] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (f.get("newPassword") !== f.get("confirmPassword")) {
      setFields({ confirmPassword: "Passwords do not match" });
      return;
    }
    setPending(true);
    setFields({});
    try {
      await api("/api/profile/password", {
        method: "POST",
        json: { currentPassword: f.get("currentPassword"), newPassword: f.get("newPassword") },
      });
      form.reset();
      toast.success("Password changed. Other devices have been signed out.");
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields ?? {});
      toast.error(err instanceof Error ? err.message : "Could not change password");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
        <CardDescription>Changing your password signs you out on all other devices.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <FormField id="currentPassword" label="Current password" error={fields.currentPassword}>
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </FormField>
          <FormField id="newPassword" label="New password" error={fields.newPassword} hint="At least 10 characters.">
            <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" required minLength={10} />
          </FormField>
          <FormField id="confirmPassword" label="Confirm new password" error={fields.confirmPassword}>
            <Input id="confirmPassword" name="confirmPassword" type="password" autoComplete="new-password" required />
          </FormField>
        </CardContent>
        <CardFooter className="mt-6 justify-end">
          <Button type="submit" variant="outline" disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />} Change password
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
