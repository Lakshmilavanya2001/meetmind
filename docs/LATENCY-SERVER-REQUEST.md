# Request: GPU server changes to cut call-translation latency

**For:** whoever runs the GPU host `10.79.253.112` (Parakeet / Riva and the Qwen LLM).
**From:** the MeetMind (VIL Voice AI POC) team, 2026-10-25.
**Reference:** our colleague's playbook "Speed optimisations for a speech-to-speech pipeline" (sections below refer to it).

## Where the time goes today

Measured from the moment a speaker stops talking to the moment the listener's translated voice starts (8-sentence English → Hindi test, after all app-side optimisations):

| Stage | Time | Who can change it |
|---|---|---|
| Pause that ends a sentence | 0.6 s | app (done; 0.5 s possible later) |
| **Speech recognition (Parakeet finishing the sentence)** | **~0.6 s** | **GPU server** |
| **Translation (Qwen 27B, whole sentence)** | **~0.5 s** | **GPU server** |
| Voice until first audio (Magpie, streamed) | 0.05 s | done |
| Waiting behind the previous sentence | ~0.5 s | app (catch-up speed, done) |
| **Total** | **~2.3–2.5 s** | |

The colleague's pipeline reaches 1.3–1.8 s, mainly because recognition takes ~0.02 s and translation ~0.2 s there.

## 1. Parakeet in offline mode (saves ~0.6 s per sentence) — highest priority

**Now:** the Riva ASR NIM at `:9000` runs `nemotron-asr-streaming` (cache-aware Parakeet RNNT multilingual) in **streaming-only** mode. `POST /v1/audio/transcriptions` is rejected (HTTP 415 even for a valid 16 kHz WAV). On the streaming API, text arrives only after a commit and takes **~0.62 s** to finish a sentence regardless of padding; provisional text is not sent during speech.

**Ask:** deploy the same multilingual Parakeet **offline** (whole-utterance) on the same GPU, next to or instead of the streaming one, so `POST /v1/audio/transcriptions` works with `language=en-US`, `hi-IN`, `es-ES`, `fr-FR`, `de-DE`, `it-IT`, `pt-BR`, `zh-CN`, `ja-JP`, `ko-KR`, `ar-AR`, `vi-VN`.

- Playbook §1.3 (`riva-build … --offline --streaming=False`, one 16 s chunk, no padding, NeMo featurizer, mel basis file) and §1.4 (validate against the framework; fp32 if fp16 outputs blanks), or the NIM's own offline profile for this model if one exists.
- §1.5: keep requests ≤ 15 s (our app cuts utterances at 15 s already).
- §1.6: healthcheck with warm-up per language and self-restart.

**Target:** ≤ 0.05 s for a 6 s utterance. **App side once it's there:** the interpreter sends one offline request per finished sentence instead of the streaming commit (small change; we'll do it).

## 2. A small dedicated translation model (saves ~0.3 s per sentence)

**Now:** translation uses `qwen3.8-27b` (thinking off) at ~19 ms per output token: 0.4–0.8 s per sentence, first words after ~0.14 s. It's the only model served at `:8000`.

**Ask:** serve a 4B-class instruction or translation model that handles **all 12 call languages** (English, Hindi, Spanish, French, German, Italian, Portuguese, Chinese, Japanese, Korean, Arabic, Vietnamese) on the model-free LLM NIM, OpenAI-compatible:

- Playbook §2.1 (model-free NIM), §2.2 flags: `--kv-cache-memory-bytes` (pinned, not a GPU share), `--max-num-batched-tokens 1024`, `--enable-prefix-caching`, `--max-model-len 4096`, `--language-model-only` for multimodal checkpoints.
- §2.3: warm up batched decoding in the healthcheck.
- We'll check translation quality per language before switching (same sentences, compared with Qwen 27B).

**Target:** ~0.2 s per sentence. **App side:** a separate base URL/model setting for interpreter translation (small change).

## 3. Parakeet server health (removes the worst cases)

In real calls on 2026-10-25 we saw, from this server:
- results up to **4 s late** (normally 0.6 s);
- sessions breaking mid-call: *"inference request … must specify the START flag on the first request of the sequence"* and *"Internal error from Core"*.

The app now reopens broken sessions and keeps idle ones alive, but each break loses a few seconds of speech. Please check the Riva logs and load at those times (around 09:13 and 09:50–10:00 UTC), and apply §0's basics: fixed memory budgets per engine, engines started one after another, warm-up before reporting healthy.

## Not needed

- Magpie TTS (`10.79.254.125:9000`): already streams first audio in ~0.05 s; no change.
- Padding before commits: measured; 0–1000 ms makes no difference.
