"""Plays the extension's role against a running backend, without Chrome or Meet.

Streams silent 16 kHz PCM chunks (so monitoring is "ok"), sends Meet-style chat messages,
and injects a scripted Hinglish conversation as text. Everything injected is marked as
mock/injected in the dashboard; this is a platform fixture, not a detection benchmark.

    python integration_tests/simulate_call.py --script digital_arrest
    python integration_tests/simulate_call.py --script benign --auto-disconnect
"""

from __future__ import annotations

import argparse
import asyncio
import json
import struct
import sys
import time
import urllib.request
import uuid

import websockets  # installed with uvicorn[standard]

SCRIPTS = {
    "digital_arrest": [
        ("speech", "Namaste, main Mumbai Police cyber crime branch se Inspector Sharma baat kar raha hoon."),
        ("speech", "Aapke naam par ek parcel aaya hai jisme drugs aur fake passport mile hain."),
        ("speech", "Aapke against FIR register hui hai, arrest warrant nikla hai."),
        ("chat", "Case file: https://mumbai-police-verify.example/fir-2026-4471"),
        ("speech", "Aap ab digital arrest mein hain. Camera on rakhiye, call disconnect mat karna."),
        ("speech", "Ye investigation confidential hai, kisi family member ko batana mat."),
        ("speech", "Abhi verification ke liye 2 lakh rupaye RBI account mein transfer karne padenge, warna jail jaana padega."),
    ],
    "otp_kyc": [
        ("speech", "Sir main SBI bank se bol raha hoon, aapka KYC expire ho gaya hai."),
        ("speech", "Apna card number aur account details confirm kijiye."),
        ("speech", "Jo OTP aaya hai woh abhi bata dijiye, warna account freeze ho jayega."),
    ],
    "benign": [
        ("speech", "Arre yaar, kal office mein kya hua pata hai?"),
        ("speech", "News mein aaya tha ki digital arrest naam ka scam chal raha hai, savdhan rehna."),
        ("speech", "Police kabhi video call pe arrest nahi karti, ye fraud hai, OTP kisi ko mat dena."),
        ("chat", "Meeting notes: https://docs.example.com/notes"),
    ],
}


def frame(header: dict, body: bytes) -> bytes:
    h = json.dumps(header, separators=(",", ":")).encode()
    return struct.pack(">I", len(h)) + h + body


def env(sid: str, etype: str, source: str, payload: dict, event_id: str | None = None) -> dict:
    return {"schema_version": "1.0", "session_id": sid, "event_id": event_id or f"{etype}-{uuid.uuid4().hex[:10]}",
            "event_type": etype, "timestamp_ms": int(time.time() * 1000), "source": source, "payload": payload}


def post(base: str, token: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(f"{base}{path}", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:8000")
    ap.add_argument("--token", default="dev-token")
    ap.add_argument("--script", choices=SCRIPTS, default="digital_arrest")
    ap.add_argument("--gap", type=float, default=3.0, help="seconds between lines")
    ap.add_argument("--auto-disconnect", action="store_true", help="simulate user opt-in")
    ap.add_argument("--linger", type=float, default=15.0)
    a = ap.parse_args()

    sid = f"sim-{a.script}-{uuid.uuid4().hex[:6]}"
    ws_url = a.base.replace("http", "ws", 1) + f"/ws/ingest?token={a.token}&session_id={sid}"
    print(f"session {sid}  dashboard: {a.base}/dashboard/?session={sid}")
    async with websockets.connect(ws_url, max_size=None) as ws:
        await ws.send(json.dumps(env(sid, "control", "extension", {"command": "session_start", "details": {
            "auto_disconnect": a.auto_disconnect, "close_tab_fallback": False, "mic_enabled": False,
            "extension_version": "simulator"}})))

        stop = asyncio.Event()

        async def audio():
            seq, base = 0, int(time.time() * 1000)
            while not stop.is_set():
                t0 = base + seq * 200
                await ws.send(frame(env(sid, "audio_chunk", "meet_tab", {
                    "seq": seq, "t_start_ms": t0, "t_end_ms": t0 + 200, "sample_rate_hz": 16000,
                    "channels": 1, "encoding": "pcm_s16le", "speaker_role": "remote"}), b"\x00\x00" * 3200))
                seq += 1
                await asyncio.sleep(0.2)

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m["event_type"] == "assessment":
                    p = m["payload"]
                    print(f"  <- assessment {p['risk_level']:>8} {p['risk_index']:3d}  state={p['monitoring_state']}"
                          f" mode={p['inference_mode']} patterns={p['patterns']}")
                elif m["event_type"] == "action":
                    p = m["payload"]
                    print(f"  <- ACTION {p['action_type']} {p['status']} {p['details'].get('cancel_window_ms', '')}")
                    if p["action_type"] == "auto_disconnect":
                        # Pretend the content script left the call after the cancel window.
                        await ws.send(json.dumps(env(sid, "action", "extension", {
                            "action_id": p["action_id"], "action_type": "auto_disconnect",
                            "status": "unverified", "details": {"note": "simulator: no real Meet tab"}})))

        tasks = [asyncio.create_task(audio()), asyncio.create_task(reader())]
        await asyncio.sleep(1.0)
        for i, (kind, text) in enumerate(SCRIPTS[a.script]):
            print(f"-> {kind}: {text}")
            if kind == "chat":
                await ws.send(json.dumps(env(sid, "chat_message", "meet_chat", {
                    "message_id": f"m{i}", "t_ms": int(time.time() * 1000), "text": text,
                    "sender_role": "unknown", "links": []})))
            else:
                await asyncio.to_thread(post, a.base, a.token, f"/api/sessions/{sid}/inject_text",
                                        {"text": text, "speaker_role": "remote"})
            await asyncio.sleep(a.gap)
        await asyncio.to_thread(post, a.base, a.token, "/api/bank/transfers",
                                {"session_id": sid, "amount": 200000, "payee": "verify.rbi@upi"})
        print("-> simulated victim transfer of INR 2,00,000")
        await asyncio.sleep(a.linger)
        stop.set()
        await ws.send(json.dumps(env(sid, "control", "extension", {"command": "session_stop", "details": {"reason": "sim_done"}})))
        for t in tasks:
            t.cancel()
    print(f"report: {a.base}/api/sessions/{sid}/report?format=md&token={a.token}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
