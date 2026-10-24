"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AudioLines, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

/** Demo: create a call record and open it with the bundled two-voice sample ready to transcribe. */
export function SampleCallButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const { joinCode } = await api<{ joinCode: string }>("/api/sample-call", { method: "POST" });
      router.push(`/meetings/${joinCode}/transcript?sample=1`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the sample call");
      setBusy(false);
    }
  }
  return (
    <Button variant="outline" onClick={go} disabled={busy} title="Transcribe, summarise and deliver a sample two-person call">
      {busy ? <Loader2 className="animate-spin" aria-hidden /> : <AudioLines aria-hidden />} Try a sample call
    </Button>
  );
}
