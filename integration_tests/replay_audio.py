"""Streams a WAV file to a running backend exactly as the extension sends tab audio
(16 kHz PCM16 mono, 200 ms chunks, real time), and prints what the live pipeline hears,
flags and decides, with latencies. Labelled "replay" in the dashboard via the session id.

    backend\\.venv\\Scripts\\python integration_tests\\replay_audio.py eval\\audio\\s01_mumbai_police_parcel.wav
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time
import uuid
import wave
from pathlib import Path

import websockets

CHUNK_MS = 200


def frame(header: dict, body: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack(">I", len(h)) + h + body


def env(sid, etype, source, payload, event_id=None):
    return {"schema_version": "1.0", "session_id": sid, "event_id": event_id or f"{etype}-{uuid.uuid4().hex[:10]}",
            "event_type": etype, "timestamp_ms": int(time.time() * 1000), "source": source, "payload": payload}


def load_pcm(path: str) -> bytes:
    w = wave.open(path)
    if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
        sys.exit(f"{path}: need 16 kHz mono 16-bit WAV, got {w.getframerate()} Hz x{w.getnchannels()} {8 * w.getsampwidth()}-bit")
    return w.readframes(w.getnframes())


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--token", default="dev-token")
    ap.add_argument("--linger", type=float, default=10.0)
    ap.add_argument("--image", help="JPEG to 'hold up' on video partway through, e.g. eval/images/demo_warrant_frame.jpg")
    ap.add_argument("--image-at", type=float, default=8.0, help="seconds into the replay to show --image")
    ap.add_argument("--before-image", help="JPEG shown before --image (default: no video until then)")
    a = ap.parse_args()

    pcm = load_pcm(a.wav)
    sid = f"replay-{Path(a.wav).stem[:30]}-{uuid.uuid4().hex[:4]}"
    ws_base = a.base.replace("http", "ws", 1)
    print(f"session {sid}  ({len(pcm) / 32000:.1f}s audio)\ndashboard: {a.base}/dashboard/?session={sid}\n")

    t_start = time.time()
    stats = {"utt_lag": [], "first": {}}

    async def watch():
        async with websockets.connect(f"{ws_base}/ws/dashboard?token={a.token}", max_size=None) as dws:
            async for raw in dws:
                m = json.loads(raw)
                if m.get("kind") != "event" or m.get("session_id") != sid:
                    continue
                e, p, now = m["event"], m["event"]["payload"], time.time() * 1000
                rel = f"{(now / 1000 - t_start):6.1f}s"
                if e["event_type"] == "utterance":
                    lag = now - p["t_end_ms"]
                    stats["utt_lag"].append(lag)
                    print(f"{rel} HEARD  [{p['speaker_role']}] {p['text']}   (speech end -> text {lag:.0f} ms)")
                elif e["event_type"] == "evidence":
                    print(f"{rel} FLAG   {p['category']} q={p['quality']} {p['rule_refs']}: “{p['quoted_text_or_observation']}”"
                          f"   (speech end -> flag {now - p['t_end_ms']:.0f} ms)")
                elif e["event_type"] == "retraction":
                    print(f"{rel} UNFLAG {len(p['evidence_ids'])} evidence: {p['reason']}")
                elif e["event_type"] == "assessment":
                    lvl = p["risk_level"]
                    stats["first"].setdefault(lvl, now / 1000 - t_start)
                    if lvl != stats.get("last_level"):
                        stats["last_level"] = lvl
                        print(f"{rel} RISK   {lvl.upper()} {p['risk_index']}  monitoring={p['monitoring_state']} mode={p['inference_mode']}")
                elif e["event_type"] == "action":
                    print(f"{rel} ACTION {p['action_type']} -> {p['status']}")

    watcher = asyncio.create_task(watch())
    await asyncio.sleep(0.5)
    async with websockets.connect(f"{ws_base}/ws/ingest?token={a.token}&session_id={sid}", max_size=None) as ws:
        await ws.send(json.dumps(env(sid, "control", "extension", {"command": "session_start", "details": {
            "auto_disconnect": False, "close_tab_fallback": False, "mic_enabled": False, "extension_version": "replay"}})))

        async def drain():
            async for _ in ws:
                pass
        drainer = asyncio.create_task(drain())

        async def video():
            """Sends a frame every 2 s like the extension, with the change score it would compute."""
            before = open(a.before_image, "rb").read() if a.before_image else None
            shown = open(a.image, "rb").read()
            seq, prev = 0, None
            while True:
                jpeg = shown if time.time() - t_start >= a.image_at else before
                if jpeg is not None:
                    change = None if prev is None else (0.3 if jpeg is not prev else 0.0)
                    payload = {"seq": seq, "t_ms": int(time.time() * 1000), "width": 1280, "height": 720, "encoding": "jpeg"}
                    if change is not None:
                        payload["change_score"] = change
                    await ws.send(frame(env(sid, "video_frame", "meet_tab", payload, f"frame-{sid}-{seq}"), jpeg))
                    if prev is not None and jpeg is not prev:
                        print(f"{time.time() - t_start:6.1f}s VIDEO  now showing {Path(a.image).name}")
                    prev, seq = jpeg, seq + 1
                await asyncio.sleep(2.0)
        video_task = asyncio.create_task(video()) if a.image else None

        n = 16000 * CHUNK_MS // 1000 * 2
        base_ms = int(time.time() * 1000)
        silence = b"\x00" * n
        chunks = [pcm[i:i + n] for i in range(0, len(pcm), n)] + [silence] * int(a.linger * 1000 / CHUNK_MS)
        for seq, chunk in enumerate(chunks):
            t0 = base_ms + seq * CHUNK_MS
            await ws.send(frame(env(sid, "audio_chunk", "meet_tab", {
                "seq": seq, "t_start_ms": t0, "t_end_ms": t0 + len(chunk) // 32, "sample_rate_hz": 16000,
                "channels": 1, "encoding": "pcm_s16le", "speaker_role": "remote"}, f"meet_tab-{sid}-{seq}"), chunk))
            # real-time pacing against the wall clock
            await asyncio.sleep(max(0.0, (t0 + CHUNK_MS) / 1000 - time.time()))
        await ws.send(json.dumps(env(sid, "control", "extension", {"command": "session_stop", "details": {"reason": "replay_done"}})))
        drainer.cancel()
        if video_task:
            video_task.cancel()
    await asyncio.sleep(1)
    watcher.cancel()

    lag = sorted(stats["utt_lag"])
    print("\nsummary:", json.dumps({
        "utterances": len(lag),
        "asr_lag_ms_p50": round(lag[len(lag) // 2]) if lag else None,
        "first_reached_s": {k: round(v, 1) for k, v in stats["first"].items()},
    }))
    print(f"report: {a.base}/api/sessions/{sid}/report?format=md&token={a.token}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
