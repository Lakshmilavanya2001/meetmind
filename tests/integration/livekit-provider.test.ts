/**
 * Runs against the real LiveKit server from docker-compose (skipped if it's not reachable).
 */
import { describe, expect, it } from "vitest";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { createHash } from "node:crypto";
import { createLiveKitProvider, readLiveKitConfig } from "@/server/providers/calling/livekit";

const config = readLiveKitConfig({ ...process.env, LIVEKIT_URL: "ws://127.0.0.1:7880" });
const reachable = await fetch("http://127.0.0.1:7880").then((r) => r.ok, () => false);

describe.skipIf(!config || !reachable)("LiveKit provider (real server)", () => {
  const provider = createLiveKitProvider(config!);
  const roomId = `mm-test-${Date.now()}`;

  it("creates rooms idempotently and lists (empty) participants", async () => {
    await provider.ensureRoom(roomId, { emptyTimeoutSec: 30 });
    await provider.ensureRoom(roomId, { emptyTimeoutSec: 30 });
    expect(await provider.listParticipants(roomId)).toEqual([]);
    await provider.endRoom(roomId);
    expect(await provider.listParticipants(roomId)).toEqual([]); // closed room → empty, not an error
  });

  it("mints short-lived tokens scoped to one room without admin rights", async () => {
    const creds = await provider.issueJoinCredentials(
      { roomId, identity: "user_1", name: "Ann", metadata: { role: "ATTENDEE" }, canPublish: true, canPublishScreen: true, ttlSeconds: 600 },
      { publicUrl: "wss://example.test" },
    );
    const claims = await new TokenVerifier(config!.apiKey, config!.apiSecret).verify(creds.token);
    expect(claims.sub).toBe("user_1");
    expect(claims.video?.room).toBe(roomId);
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.roomAdmin).toBeFalsy();
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(600);
    expect(creds.serverUrl).toBe("wss://example.test");
  });

  it("accepts correctly signed webhooks and rejects forged ones", async () => {
    const body = JSON.stringify({ event: "participant_joined", room: { name: roomId }, participant: { identity: "user_1" }, createdAt: "1767261600" });
    const at = new AccessToken(config!.apiKey, config!.apiSecret);
    at.sha256 = createHash("sha256").update(body).digest("base64");
    const event = await provider.parseWebhook(body, await at.toJwt());
    expect(event).toMatchObject({ type: "participant_joined", roomId, identity: "user_1" });

    const forged = new AccessToken(config!.apiKey, "not-the-real-secret-but-long-enough-123");
    forged.sha256 = createHash("sha256").update(body).digest("base64");
    await expect(provider.parseWebhook(body, await forged.toJwt())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(provider.parseWebhook(body.replace("user_1", "user_2"), await at.toJwt())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
