"""Frame analysis with a Gemini multimodal model (OpenAI-compatible endpoint).

Reports what is visible: documents/IDs held up or screen-shared with their text read out,
and appearance cues (uniform, badge/emblem, official backdrop). It never judges whether a
document is genuine. Read-out text is fed to the text detector as a "screen" line, so it is
judged in conversational context like speech; appearance cues become capped modifiers.

Architecture note: the intended design is a local YOLO-World + OCR stage that triggers this
model only on detected regions; this PoC calls Gemini directly on gated frames.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from dataclasses import dataclass, field

import httpx

from .detector import PROVIDER_URLS, _cooldown_s, _parse_json_content

log = logging.getLogger("callshield.vision")

VISION_PROMPT = """You analyse one frame of a Google Meet video call for a fraud-protection tool.
The frame may contain the meeting UI (participant names, buttons, captions): IGNORE all UI text.

Report ONLY what is visibly shown by a participant or on a shared screen:
1. documents: any ID card, warrant, notice, letter, court order, FIR, bank/payment details, QR code or similar
   that someone holds up or shares. For each: "kind" (id_card | warrant | court_or_legal_notice | fir |
   letter | bank_or_payment_details | qr_code | other_document), "text": the readable text copied exactly
   (keep the original language and script; "" if unreadable), "agency": the organisation it names, if any.
2. cues: zero or more of "police_style_uniform", "badge_or_emblem", "official_office_backdrop",
   "payment_details_on_screen".
Do NOT judge whether anything is genuine or fake. Do not guess text you cannot read.

Reply with JSON only:
{"documents":[{"kind":"...","text":"...","agency":"..."}],"cues":["..."],"confidence":0.0}"""

KINDS = {"id_card", "warrant", "court_or_legal_notice", "fir", "letter", "bank_or_payment_details",
         "qr_code", "other_document"}
CUES = {"police_style_uniform", "badge_or_emblem", "official_office_backdrop", "payment_details_on_screen"}


@dataclass
class FrameObservation:
    documents: list[dict] = field(default_factory=list)
    cues: list[str] = field(default_factory=list)
    confidence: float = 0.5
    latency_ms: int = 0


@dataclass
class VisionStats:
    calls: int = 0
    failures: int = 0
    rate_limited: int = 0
    last_latency_ms: int | None = None
    last_error: str | None = None


class GeminiVision:
    def __init__(self, api_key: str, model: str | None = None, timeout_s: float = 20.0):
        self.api_key = api_key
        self.model = model or os.environ.get("CALLSHIELD_VISION_MODEL", "gemini-3.5-flash-lite")
        self.stats = VisionStats()
        self.limited_until = 0.0
        self._client = httpx.AsyncClient(timeout=timeout_s)

    @property
    def available(self) -> bool:
        return time.monotonic() >= self.limited_until

    async def aclose(self) -> None:
        await self._client.aclose()

    async def analyze(self, jpeg: bytes) -> FrameObservation:
        t0 = time.monotonic()
        self.stats.calls += 1
        body = {
            "model": self.model,
            "temperature": 0,
            "max_tokens": 800,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": VISION_PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}},
            ]}],
        }
        try:
            r = await self._client.post(PROVIDER_URLS["gemini"], json=body,
                                        headers={"Authorization": f"Bearer {self.api_key}"})
            if r.status_code == 429:
                self.stats.rate_limited += 1
                self.limited_until = time.monotonic() + _cooldown_s(r)
                raise RuntimeError("vision model rate limited")
            r.raise_for_status()
            out = _parse_json_content(r.json()["choices"][0]["message"]["content"])
        except Exception as e:
            self.stats.failures += 1
            self.stats.last_error = repr(e)[:200]
            raise
        self.stats.last_latency_ms = int((time.monotonic() - t0) * 1000)
        self.stats.last_error = None
        return self.validate(out, self.stats.last_latency_ms)

    @staticmethod
    def validate(out: dict, latency_ms: int = 0) -> FrameObservation:
        docs = []
        for d in out.get("documents") or [] if isinstance(out, dict) else []:
            if isinstance(d, dict) and d.get("kind") in KINDS:
                docs.append({"kind": d["kind"], "text": str(d.get("text") or "").strip()[:1500],
                             "agency": str(d.get("agency") or "").strip()[:120]})
        cues = [c for c in (out.get("cues") or []) if c in CUES] if isinstance(out, dict) else []
        try:
            conf = max(0.0, min(1.0, float(out.get("confidence", 0.5))))
        except (TypeError, ValueError, AttributeError):
            conf = 0.5
        return FrameObservation(docs, sorted(set(cues)), conf, latency_ms)
