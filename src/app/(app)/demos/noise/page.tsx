import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "@/server/auth/current";
import { PageHeader } from "@/components/common/page-header";
import { NoiseLab } from "@/components/demos/noise-lab";

export const metadata: Metadata = { title: "Noise cancellation" };

export default async function NoiseDemoPage() {
  await requireAuth();
  return (
    <div className="mx-auto grid max-w-5xl gap-2">
      <Link href="/demos" className="text-sm text-muted-foreground hover:text-foreground">← Demos</Link>
      <PageHeader
        title="Noise cancellation"
        description="Hear what AI noise removal does to a noisy voice, and how much it improves it. RNNoise is what “Enhanced” noise cancellation uses in calls; GTCRN and classic Speex are shown for comparison. Everything runs in your browser."
      />
      <NoiseLab />
    </div>
  );
}
