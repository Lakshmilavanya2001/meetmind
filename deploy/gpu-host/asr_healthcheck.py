"""Healthcheck for the ASR NIM (Parakeet 1.1B RNNT multilingual, offline): up, and warmed up.

The first request in each language is slower than the rest. The first time the server answers
after a container start, this transcribes a short clip in each language, and only then reports
healthy.
"""
import io
import math
import os
import random
import sys
import urllib.request
import uuid
import wave

BASE = "http://127.0.0.1:9000"
LANGUAGES = os.environ.get("ASR_WARM_LANGUAGES", "en-US hi-IN").split()


def clip() -> bytes:
    """1.5 s of a quiet tone with noise, 16 kHz mono WAV: enough to run the whole model."""
    sr = 16000
    frames = b"".join(int(800 * math.sin(i / 9) + random.randint(-200, 200)).to_bytes(2, "little", signed=True)
                      for i in range(int(sr * 1.5)))
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)
    return out.getvalue()


def transcribe(audio: bytes, language: str):
    boundary = uuid.uuid4().hex
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n{language}\r\n'.encode(),
             f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n'
             f'Content-Type: audio/wav\r\n\r\n'.encode() + audio + b"\r\n",
             f"--{boundary}--\r\n".encode()]
    req = urllib.request.Request(f"{BASE}/v1/audio/transcriptions", b"".join(parts),
                                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        r.read()


def main() -> int:
    try:
        urllib.request.urlopen(f"{BASE}/v1/health/ready", timeout=3).read()
    except OSError:
        return 1                                        # still loading
    # one marker per container start: PID 1's start time changes when the container restarts
    marker = "/tmp/asr-warm-" + open("/proc/1/stat").read().rsplit(")", 1)[1].split()[19]
    if os.path.exists(marker):
        return 0
    audio = clip()
    for language in LANGUAGES:
        transcribe(audio, language)
    open(marker, "w").close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
