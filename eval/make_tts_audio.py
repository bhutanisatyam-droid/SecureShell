"""Synthesize the remote-caller side of dev conversations with Sarvam TTS (16 kHz mono WAV).

    backend\\.venv\\Scripts\\python eval\\make_tts_audio.py s01_mumbai_police_parcel b01_awareness_discussion

Synthetic speech is clean and unaccented-for-noise, so ASR results on it are optimistic:
report them separately from team-recorded audio.
"""

from __future__ import annotations

import base64
import io
import sys
import wave
from pathlib import Path

import httpx
import yaml
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
GAP_S = 0.9


def tts(key: str, text: str) -> tuple[bytes, int]:
    r = httpx.post("https://api.sarvam.ai/text-to-speech", headers={"api-subscription-key": key},
                   json={"text": text, "target_language_code": "hi-IN", "speech_sample_rate": 16000}, timeout=60)
    r.raise_for_status()
    w = wave.open(io.BytesIO(base64.b64decode(r.json()["audios"][0])))
    assert w.getnchannels() == 1 and w.getsampwidth() == 2, "expected 16-bit mono"
    return w.readframes(w.getnframes()), w.getframerate()


def main() -> int:
    key = dotenv_values(ROOT / "backend" / ".env")["SARVAM_API_KEY"]
    convs = {c["id"]: c for c in yaml.safe_load(open(ROOT / "eval" / "dev_conversations.yaml", encoding="utf-8"))["conversations"]}
    out_dir = ROOT / "eval" / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    for cid in sys.argv[1:]:
        pcm, rate = b"", None
        for role, text in convs[cid]["lines"]:
            if role == "L":
                continue
            data, sr = tts(key, text)
            if rate is None:
                rate = sr
            assert sr == rate
            pcm += data + b"\x00\x00" * int(rate * GAP_S)
        path = out_dir / f"{cid}.wav"
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate); w.writeframes(pcm)
        print(f"{path}  {len(pcm) / 2 / rate:.1f}s @ {rate} Hz")
    return 0


if __name__ == "__main__":
    sys.exit(main())
