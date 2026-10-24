import "server-only";
import type { NextRequest } from "next/server";
import { AppError } from "./errors";
import { readBodyLimited } from "./http";

/** Read a multipart upload (one audio file + string fields), never buffering more than the limit. */
export async function readAudioUpload(req: NextRequest, maxBytes: number) {
  const raw = await readBodyLimited(req, maxBytes + 64 * 1024);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new AppError("VALIDATION", "Expected multipart/form-data.");
  }
  const file = form.get("audio");
  if (!(file instanceof Blob)) throw new AppError("VALIDATION", "Missing audio file.");
  if (file.size > maxBytes) throw new AppError("VALIDATION", "Audio chunk is too large.");
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  return { audio: { data: Buffer.from(await file.arrayBuffer()), mimeType: file.type || "application/octet-stream" }, fields };
}
