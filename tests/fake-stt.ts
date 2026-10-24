import { vi } from "vitest";
import { TransientSttError, type SttProvider } from "@/server/providers/stt";

/** Fake STT: returns the audio bytes as text (tests upload text as "audio"), with scripted failures. */
export function createFakeStt() {
  const failures: ("transient" | "permanent")[] = [];
  const stt: SttProvider & { failNext(kind: "transient" | "permanent", times?: number): void } = {
    model: "fake-stt",
    languages: ["en", "hi"],
    transcribe: vi.fn(async (audio: Buffer) => {
      const f = failures.shift();
      if (f === "transient") throw new TransientSttError("busy");
      if (f === "permanent") throw new Error("unsupported audio");
      return { text: audio.toString("utf8").replace(/^RIFF/, "").trim() };
    }),
    failNext(kind, times = 1) {
      for (let i = 0; i < times; i++) failures.push(kind);
    },
  };
  return stt;
}
