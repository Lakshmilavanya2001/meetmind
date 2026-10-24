import { createHash, randomBytes } from "node:crypto";

/** Opaque random token for cookies / invitation links. */
export const generateToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Only hashes are stored, so a database leak does not leak live sessions. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no "l" to avoid confusion with "1"/"I"

/** Human-friendly code like "kqd-mxta-pwe" (meeting IDs, workspace join codes). */
export function generateHumanCode(groups: number[] = [3, 4, 3]) {
  const bytes = randomBytes(groups.reduce((a, b) => a + b, 0));
  let i = 0;
  return groups
    .map((n) => Array.from({ length: n }, () => ALPHABET[bytes[i++] % ALPHABET.length]).join(""))
    .join("-");
}
