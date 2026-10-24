"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormField } from "@/components/form-field";
import { api, ApiError } from "@/lib/api";

export function SignupForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  // Browser time zone; "UTC" during server render.
  const timezone = useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    () => "UTC",
  );
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    setFields({});
    try {
      await api("/api/auth/signup", {
        method: "POST",
        json: {
          displayName: f.get("displayName"),
          email: f.get("email"),
          password: f.get("password"),
          timezone,
          workspaceMode: mode,
          workspaceName: mode === "create" ? f.get("workspaceName") : undefined,
          joinCode: mode === "join" ? f.get("joinCode") : undefined,
        },
      });
      router.replace("/dashboard");
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
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Create your account</CardTitle>
        <CardDescription>Start a new workspace or join your team&apos;s.</CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit} noValidate>
        <CardContent className="grid gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <FormField id="displayName" label="Full name" error={fields.displayName}>
            <Input id="displayName" name="displayName" autoComplete="name" required autoFocus />
          </FormField>
          <FormField id="email" label="Work email" error={fields.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </FormField>
          <FormField id="password" label="Password" error={fields.password} hint="At least 10 characters.">
            <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
          </FormField>

          <Tabs value={mode} onValueChange={(v) => setMode(v as "create" | "join")}>
            <TabsList className="w-full">
              <TabsTrigger value="create">Create workspace</TabsTrigger>
              <TabsTrigger value="join">Join workspace</TabsTrigger>
            </TabsList>
          </Tabs>
          {mode === "create" ? (
            <FormField id="workspaceName" label="Workspace name" error={fields.workspaceName}>
              <Input id="workspaceName" name="workspaceName" placeholder="Acme Engineering" required />
            </FormField>
          ) : (
            <FormField
              id="joinCode"
              label="Workspace join code"
              error={fields.joinCode}
              hint="Ask a workspace admin — it's shown on their Workspace settings page."
            >
              <Input id="joinCode" name="joinCode" placeholder="abcd-efgh" required autoCapitalize="none" />
            </FormField>
          )}
          <p className="text-xs text-muted-foreground">
            Time zone detected as <span className="font-medium text-foreground">{timezone}</span>. You can change it in
            your profile.
          </p>
        </CardContent>
        <CardFooter className="mt-6 flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending}>
            {pending && <Loader2 className="animate-spin" aria-hidden />}
            Create account
          </Button>
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
