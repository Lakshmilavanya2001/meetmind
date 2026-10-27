"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Car, CheckCircle2, FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

const RESULT: Record<string, [ok: boolean, message: string]> = {
  connected: [true, "Uber connected"],
  denied: [false, "Uber sign-in was cancelled"],
  expired: [false, "That Uber sign-in expired. Try again."],
  signin: [false, "Sign in to MeetMind first, then connect Uber"],
  error: [false, "Uber didn't accept the sign-in. Check the Uber app's settings and try again."],
};

/** Connect your own Uber account so the assistant can show real fares and book rides (test mode by default). */
export function UberCard({ configured, env, connected, needsReconnect }: { configured: boolean; env: "sandbox" | "production" | null; connected: boolean; needsReconnect: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, setBusy] = useState(false);
  const result = params.get("uber");

  useEffect(() => {
    const r = result ? RESULT[result] : undefined;
    if (!r) return;
    if (r[0]) toast.success(r[1]);
    else toast.error(r[1]);
    router.replace("/settings/profile", { scroll: false });
  }, [result, router]);

  async function disconnect() {
    if (!confirm("Disconnect your Uber account? The assistant will go back to the sandbox for cabs.")) return;
    setBusy(true);
    try {
      await api("/api/integrations/uber/disconnect", { method: "POST" });
      toast.success("Uber disconnected");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Car className="size-4" aria-hidden /> Uber
          {env === "sandbox" && <Badge variant="outline" title="No real car comes and nothing is charged"><FlaskConical aria-hidden /> Test mode</Badge>}
          {env === "production" && <Badge variant="destructive">Real rides</Badge>}
        </CardTitle>
        <CardDescription>
          Connect your Uber account and the assistant shows Uber&apos;s real options and fares, and books rides after you confirm.{" "}
          {env === "production" ? "Rides are real and charged to your Uber account." : "In test mode no real car comes and nothing is charged."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!configured ? (
          <p className="text-sm text-muted-foreground">Uber isn&apos;t set up on this server yet. Cab bookings use the sandbox.</p>
        ) : connected ? (
          <div className="flex items-center justify-between gap-4">
            <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="size-4 text-emerald-600" aria-hidden /> Your Uber account is connected.</p>
            <Button variant="outline" onClick={disconnect} disabled={busy}>{busy && <Loader2 className="animate-spin" aria-hidden />} Disconnect</Button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm">{needsReconnect ? "Your Uber login has expired." : "Not connected. Cab bookings use the sandbox."}</p>
            {/* A full page navigation: the server redirects to Uber's sign-in. */}
            <Button asChild>
              <a href="/api/integrations/uber/connect">{needsReconnect ? "Reconnect Uber" : "Connect Uber"}</a>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
