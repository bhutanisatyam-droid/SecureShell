"""Streaming Hinglish ASR over Sarvam's WebSocket API (saaras, codemix mode).

One stream per (session, audio source). Raw 16 kHz PCM goes in as captured; final
transcripts come out with times mapped back onto our audio timeline (the API returns no
word timestamps, so segment bounds are taken from the VAD events against the audio we
have sent: accurate to roughly one chunk).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from typing import Awaitable, Callable
from urllib.parse import urlencode

import websockets

log = logging.getLogger("callshield.asr")

URL = "wss://api.sarvam.ai/speech-to-text/ws"
PRE_SPEECH_PAD_MS = 9 * 32  # Sarvam default pre_speech_pad_frames (512 samples @ 16 kHz)

OnFinal = Callable[[str, int, int, str | None], Awaitable[None]]


class SarvamStream:
    def __init__(self, api_key: str, on_final: OnFinal, *, label: str, model: str = "saaras:v4",
                 mode: str = "codemix", language_code: str = "hi-IN", sample_rate: int = 16000):
        self.api_key = api_key
        self.on_final = on_final
        self.label = label
        self.params = {
            "model": model, "mode": mode, "language-code": language_code,
            "sample_rate": str(sample_rate), "input_audio_codec": "pcm_s16le",
            "vad_signals": "true", "high_vad_sensitivity": "true",
        }
        self.sample_rate = sample_rate
        self._q: asyncio.Queue[tuple[bytes, int, int]] = asyncio.Queue(maxsize=300)  # ~60 s
        self._task: asyncio.Task | None = None
        self._closed = False
        self.connected = False
        self.error: str | None = None
        self.error_at: float | None = None
        self.sent_t_end: int | None = None
        self._speech_start: int | None = None
        self._speech_end: int | None = None
        self.dropped = 0
        self.finals = 0

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"sarvam-{self.label}")

    def push(self, pcm: bytes, t_start_ms: int, t_end_ms: int) -> None:
        while True:
            try:
                self._q.put_nowait((pcm, t_start_ms, t_end_ms))
                return
            except asyncio.QueueFull:
                self._q.get_nowait()
                self.dropped += 1

    async def close(self) -> None:
        self._closed = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    def failing_for_s(self) -> float:
        if self.error_at is None or self.connected:
            return 0.0
        return time.monotonic() - self.error_at

    async def _run(self) -> None:
        backoff = 1.0
        url = f"{URL}?{urlencode(self.params)}"
        while not self._closed:
            try:
                async with websockets.connect(
                    url, additional_headers={"Api-Subscription-Key": self.api_key},
                    open_timeout=10, ping_interval=20, max_size=2**20,
                ) as ws:
                    self.connected, self.error, self.error_at = True, None, None
                    backoff = 1.0
                    sender = asyncio.create_task(self._send(ws))
                    try:
                        async for raw in ws:
                            await self._on_message(json.loads(raw))
                    finally:
                        sender.cancel()
                if not self._closed:
                    self._fail("connection closed by server")
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self._fail(repr(e))
            self.connected = False
            if self._closed:
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10.0)

    def _fail(self, msg: str) -> None:
        self.connected = False
        self.error = msg[:300]
        if self.error_at is None:
            self.error_at = time.monotonic()
        log.warning("sarvam %s: %s", self.label, self.error)

    async def _send(self, ws) -> None:
        while True:
            pcm, _t0, t1 = await self._q.get()
            await ws.send(json.dumps({"audio": {
                "data": base64.b64encode(pcm).decode("ascii"),
                "sample_rate": str(self.sample_rate),
                "encoding": "audio/wav",
            }}))
            self.sent_t_end = t1

    async def _on_message(self, m: dict) -> None:
        kind, data = m.get("type"), m.get("data") or {}
        if kind == "events":
            sig = data.get("signal_type")
            if sig == "START_SPEECH" and self.sent_t_end is not None:
                self._speech_start = self.sent_t_end - PRE_SPEECH_PAD_MS
            elif sig == "END_SPEECH":
                self._speech_end = self.sent_t_end
        elif kind == "data":
            text = (data.get("transcript") or "").strip()
            if not text:
                return
            t1 = self._speech_end or self.sent_t_end or 0
            t0 = self._speech_start if self._speech_start is not None and self._speech_start <= t1 else t1
            self._speech_start = self._speech_end = None
            self.finals += 1
            await self.on_final(text, t0, t1, data.get("language_code"))
        elif kind == "error":
            raise RuntimeError(f"sarvam error {data.get('code')}: {data.get('error')}")
