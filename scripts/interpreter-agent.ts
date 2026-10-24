/**
 * The AI interpreter process. Joins every live meeting that has interpretation switched on,
 * and leaves when it's switched off or the meeting ends.
 *   npm run interpreter          (run with: tsx --conditions=react-server)
 */
import "dotenv/config";
import { db } from "@/server/db";
import { readRivaConfig } from "@/server/providers/stt";
import { RoomServiceClient } from "livekit-server-sdk";
import { MeetingInterpreter, INTERPRETER_IDENTITY, type AgentConfig } from "@/server/interpreter/livekit-agent";

const POLL_MS = 2000;
// Leave a call nobody is in, so LiveKit can close the room and the meeting ends normally.
const LEAVE_EMPTY_AFTER_MS = 30_000;

function config(): AgentConfig {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  const riva = readRivaConfig();
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) throw new Error("LiveKit is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).");
  if (!riva) throw new Error("The interpreter needs streaming speech recognition (RIVA_REALTIME_URL).");
  return { livekitUrl: LIVEKIT_URL.replace(/^http/, "ws"), apiKey: LIVEKIT_API_KEY, apiSecret: LIVEKIT_API_SECRET, riva };
}

async function main() {
  const cfg = config();
  const rooms = new RoomServiceClient(cfg.livekitUrl.replace(/^ws/, "http"), cfg.apiKey, cfg.apiSecret);
  const peopleIn = async (roomId: string) =>
    (await rooms.listParticipants(roomId).catch(() => [])).filter((p) => p.identity !== INTERPRETER_IDENTITY).length;
  const running = new Map<string, MeetingInterpreter>();
  const starting = new Set<string>();
  console.log("[interpreter] agent started");

  const tick = async () => {
    const wanted = await db.meeting.findMany({
      where: { status: "LIVE", interpretationEnabled: true, providerRoomId: { not: null }, provider: "LIVEKIT" },
      select: { id: true, providerRoomId: true },
    });
    const ids = new Set(wanted.map((m) => m.id));
    for (const m of wanted) {
      const r = running.get(m.id);
      if (r && (!r.connected || r.emptyForMs() > LEAVE_EMPTY_AFTER_MS)) {
        running.delete(m.id);
        await r.stop();
        continue; // rejoins on a later tick if people are (still) there
      }
      if (r) {
        await r.refresh().catch((e) => console.error("[interpreter] refresh failed", (e as Error).message));
        continue;
      }
      if (starting.has(m.id) || (await peopleIn(m.providerRoomId!)) === 0) continue;
      starting.add(m.id);
      const agent = new MeetingInterpreter({ id: m.id, roomId: m.providerRoomId! }, cfg);
      agent
        .start()
        .then(() => running.set(m.id, agent))
        .catch((e) => console.error(`[interpreter] couldn't join ${m.providerRoomId}:`, (e as Error).message))
        .finally(() => starting.delete(m.id));
    }
    for (const [id, agent] of running) {
      if (ids.has(id)) continue;
      running.delete(id);
      await agent.stop();
    }
  };

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((e) => console.error("[interpreter] tick failed", (e as Error).message))
      .finally(() => (busy = false));
  }, POLL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await Promise.all([...running.values()].map((a) => a.stop()));
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[interpreter]", (e as Error).message);
  process.exit(1);
});
