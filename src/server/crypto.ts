import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { AppError } from "./errors";

// AES-256-GCM for secrets at rest (e.g. IntegrationConnection.encryptedCredentials).
// Format: "v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>". The key comes from ENCRYPTION_KEY (32 bytes, base64).

function key(env: Record<string, string | undefined> = process.env) {
  const raw = env.ENCRYPTION_KEY;
  const k = raw ? Buffer.from(raw, "base64") : null;
  if (!k || k.length !== 32) throw new AppError("NOT_CONFIGURED", "ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  return k;
}

export function encryptSecret(plaintext: string, env?: Record<string, string | undefined>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(env), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, env?: Record<string, string | undefined>) {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new AppError("INTERNAL", "Unrecognised encrypted secret format.");
  const decipher = createDecipheriv("aes-256-gcm", key(env), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new AppError("INTERNAL", "Could not decrypt secret (wrong ENCRYPTION_KEY or tampered data).");
  }
}

export const encryptJson = (value: unknown, env?: Record<string, string | undefined>) => encryptSecret(JSON.stringify(value), env);
export const decryptJson = <T>(payload: string, env?: Record<string, string | undefined>) => JSON.parse(decryptSecret(payload, env)) as T;
