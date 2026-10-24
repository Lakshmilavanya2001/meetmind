"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";

type Check = { id: string; name: string; status: "ok" | "error" | "not_configured"; detail: string; required: boolean };

export function IntegrationsCard() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChecks((await api<{ checks: Check[] }>("/api/admin/integrations")).checks);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function testSmtp() {
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; message: string }>("/api/admin/integrations/smtp-test", { method: "POST" });
      (r.ok ? toast.success : toast.error)(r.message);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="text-base">Integrations & services</CardTitle>
          <CardDescription>Live status of the services this server depends on.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading} aria-label="Refresh status">
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </CardHeader>
      <CardContent>
        {!checks ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Checking…</p>
        ) : (
          <ul className="divide-y">
            {checks.map((c) => (
              <li key={c.id} className="flex items-start gap-3 py-2.5">
                {c.status === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-label="OK" /> : c.status === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Problem" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Not configured" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{c.name}{c.required && <span className="ml-1 text-xs font-normal text-muted-foreground">(required)</span>}</p>
                  <p className="text-xs break-words text-muted-foreground">{c.detail}</p>
                </div>
                {c.id === "email" && c.status !== "not_configured" && (
                  <Button size="sm" variant="ghost" onClick={testSmtp} disabled={testing}>{testing && <Loader2 className="animate-spin" aria-hidden />} Test login</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
