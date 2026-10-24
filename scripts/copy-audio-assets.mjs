// Copies the RNNoise noise-suppression worklet + WASM (MIT) into public/noise so the browser can load them.
// Runs automatically before `npm run build` (prebuild), so the assets always match the installed version.
import { copyFileSync, mkdirSync } from "node:fs";
const src = "node_modules/@sapphi-red/web-noise-suppressor";
mkdirSync("public/noise", { recursive: true });
for (const [from, to] of [
  ["dist/rnnoise/workletProcessor.js", "rnnoiseWorklet.js"],
  ["dist/rnnoise.wasm", "rnnoise.wasm"],
  ["dist/rnnoise_simd.wasm", "rnnoise_simd.wasm"],
  ["dist/gtcrn/workletProcessor.js", "gtcrnWorklet.js"],
  ["dist/gtcrn.wasm", "gtcrn.wasm"],
  ["dist/speex/workletProcessor.js", "speexWorklet.js"],
  ["dist/speex.wasm", "speex.wasm"],
  ["LICENSE", "LICENSE.txt"],
]) copyFileSync(`${src}/${from}`, `public/noise/${to}`);
copyFileSync("scripts/noise-third-party-notices.txt", "public/noise/THIRD_PARTY_NOTICES.txt");
console.log("copied noise-suppression assets to public/noise");
