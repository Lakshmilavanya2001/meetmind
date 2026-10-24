import type { Metadata } from "next";
import Link from "next/link";
import { AudioLines, Bot, Clapperboard, FileText, Languages, Pizza } from "lucide-react";
import { requireAuth } from "@/server/auth/current";
import { PageHeader } from "@/components/common/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SampleCallButton } from "@/components/meetings/sample-call-button";

export const metadata: Metadata = { title: "Demos" };

const Step = ({ children }: { children: React.ReactNode }) => <li className="text-sm text-muted-foreground">{children}</li>;

export default async function DemosPage() {
  await requireAuth();
  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <PageHeader title="Demos" description="The four voice-AI use cases, end to end. Each one runs on the live models; bookings and orders use clearly labelled sandbox partners." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><FileText className="size-4 text-primary" aria-hidden /> 1 · Call transcription and summary</CardTitle>
            <CardDescription>A recorded two-person call → text with speakers told apart → AI summary → delivered to each person.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ol className="grid list-decimal gap-1 pl-5">
              <Step>Click <strong>Try a sample call</strong>, then <strong>Transcribe</strong>.</Step>
              <Step>Speakers, talk time and the transcript appear; the summary follows automatically.</Step>
              <Step>The <strong>Summary delivery</strong> panel shows in-app, email and SMS delivery; the email is in <Link className="underline" href="/settings/messages">Messages</Link>.</Step>
            </ol>
            <div><SampleCallButton /></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Languages className="size-4 text-primary" aria-hidden /> 2 · Real-time voice translation</CardTitle>
            <CardDescription>Two people in a call, each hearing the other in their own language — English and 22 Indian languages.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ol className="grid list-decimal gap-1 pl-5">
              <Step>Start a meeting and have the other person join from the link (two devices, or two browsers).</Step>
              <Step>Each person opens the <strong>AI interpreter</strong> button in the call and picks their language; the host turns it on.</Step>
              <Step>Speak: the other side hears the translation, with the original and translated text and the latency of each line on screen.</Step>
              <Step>After the call, the meeting page shows the <strong>latency report</strong> (average, median, 95th percentile).</Step>
            </ol>
            <div><Button asChild variant="outline"><Link href="/meetings">Go to meetings</Link></Button></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><AudioLines className="size-4 text-primary" aria-hidden /> 3 · Noise cancellation</CardTitle>
            <CardDescription>Noisy speech before and after AI noise removal, with measured improvement — the same model used in calls.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ol className="grid list-decimal gap-1 pl-5">
              <Step>Pick office, street or café noise — or record your own.</Step>
              <Step>Listen to the original, then each model; compare the spectrograms and the numbers.</Step>
            </ol>
            <div><Button asChild><Link href="/demos/noise">Open noise cancellation</Link></Button></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><Bot className="size-4 text-primary" aria-hidden /> 4 · AI agent for ordering and booking</CardTitle>
            <CardDescription>Ask by voice or chat; the agent asks for what&apos;s missing, confirms, and submits to the partner — then watch it arrive.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ol className="grid list-decimal gap-1 pl-5">
              <Step>In the <Link className="underline" href="/assistant">Assistant</Link>, press the microphone (or type): “Order two medium Margherita pizzas from Slice Republic” or “Book two movie tickets for tomorrow evening”.</Step>
              <Step>Answer its questions (address, film, show, seats), check the summary and press <strong>Confirm</strong>.</Step>
              <Step>Open the partner site to see the order arrive and progress.</Step>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button asChild><Link href="/assistant">Open the assistant</Link></Button>
              <Button asChild variant="outline"><Link href="/partners/food?restaurant=r-slice-republic"><Pizza aria-hidden /> Pizzeria portal</Link></Button>
              <Button asChild variant="outline"><Link href="/partners/cinema"><Clapperboard aria-hidden /> Cinema box office</Link></Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
