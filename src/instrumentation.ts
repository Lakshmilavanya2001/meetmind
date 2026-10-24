// Runs once per server start. Starts background workers in the Node.js runtime only.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.DISABLE_WORKERS !== "true") {
    const { startTranscriptionWorker } = await import("./server/jobs/transcription-worker");
    startTranscriptionWorker();
  }
}
