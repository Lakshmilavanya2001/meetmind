import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Minimal blob storage. Local disk for now; keys are opaque and never exposed as URLs.
// Swap for S3/GCS by implementing the same three functions.
// Runtime data directory, not source: excluded from the bundler's file tracing.
const root = () => path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? "uploads");

function resolveKey(key: string) {
  if (!/^[\w./-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
  return path.join(/*turbopackIgnore: true*/ root(), key);
}

export async function putObject(key: string, data: Buffer) {
  const file = resolveKey(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data, { mode: 0o600 });
}

export const getObject = (key: string) => readFile(resolveKey(key));

export async function deleteObject(key: string) {
  await rm(resolveKey(key), { force: true });
}
