"""Boundary between the platform and Shlok's AI pipeline.

Shlok implements a class with the AIPipeline interface (ASR, semantic detection, LLM
context, tone, vision) and points CALLSHIELD_PIPELINE at it, e.g.
    CALLSHIELD_PIPELINE=shlok_pipeline:Pipeline
The platform calls it per modality on separate workers, with timeouts; the pipeline pushes
`utterance` and `evidence` envelopes back through the `emit` callback given at session start.

MockPipeline below is a placeholder so the platform can be exercised end to end before the
real models exist. It does NO speech recognition and every event it emits has is_mock=True.
"""

from __future__ import annotations

import importlib
import re
from typing import Awaitable, Callable, Protocol

from .contracts import (
    AudioChunk, ChatMessage, Envelope, Evidence, Utterance, VideoFrame, make_event, new_id,
)

Emit = Callable[[Envelope], Awaitable[None]]


class AIPipeline(Protocol):
    name: str
    is_mock: bool

    async def start_session(self, session_id: str, emit: Emit) -> None: ...
    async def on_audio(self, session_id: str, event_id: str, chunk: AudioChunk, pcm: bytes) -> None: ...
    async def on_video(self, session_id: str, event_id: str, frame: VideoFrame, jpeg: bytes) -> None: ...
    async def on_chat(self, session_id: str, event_id: str, msg: ChatMessage) -> None: ...
    # Text that did not come from our ASR (debug injection, transcript replay for text-only eval).
    async def on_text(self, session_id: str, event_id: str, utt: Utterance) -> None: ...
    async def end_session(self, session_id: str) -> None: ...
    def health(self) -> dict: ...


def load_pipeline(spec: str | None) -> AIPipeline:
    """spec: "auto" (default: live if both API keys are set, else mock), "live", "mock",
    or "module:Class" for an external implementation."""
    import os
    spec = spec or "auto"
    if spec == "auto":
        spec = "live" if os.environ.get("SARVAM_API_KEY") and os.environ.get("GROQ_API_KEY") else "mock"
    if spec == "mock":
        return MockPipeline()
    if spec == "live":
        from .ai.pipeline import LivePipeline
        return LivePipeline()
    module_name, _, cls_name = spec.partition(":")
    cls = getattr(importlib.import_module(module_name), cls_name or "Pipeline")
    return cls()


# Crude placeholder patterns. NOT the detection approach; Shlok's semantic engine replaces this.
_MOCK_RULES: list[tuple[str, re.Pattern]] = [
    # Roman Hinglish plus the Devanagari forms streaming ASR emits for Hindi words.
    # Devanagari alternatives sit outside \b: vowel signs are not \w in Python's re.
    ("digital_arrest_claim", re.compile(r"digital\s*arrest|डिजिटल\s*अरेस्ट|digital\s*custody", re.I)),
    ("authority_claim", re.compile(r"\b(police|cbi|customs|cyber\s*crime|ncb|narcotics|enforcement directorate|trai)\b|पुलिस|सीबीआई|कस्टम|अधिकारी", re.I)),
    ("legal_threat", re.compile(r"\b(arrest|warrant|fir|jail|giraftar|case (register|darj))\b|गिरफ्तार|वारंट|जेल|केस\s*(दर्ज|register)", re.I)),
    ("credential_request", re.compile(r"(\b(otp|cvv|upi pin|pin|password|verification code|six[- ]digit code|code)\b|ओटीपी|कोड|पिन).*(\b(bata|batao|bataiye|share|bhejo|boliye|bolo|tell|send|dijiye)\b|बता|बोलिए|बोलो|दीजिए|भेज)", re.I)),
    ("payment_demand", re.compile(r"(\b(paise|payment|amount|rupaye|rupees|fine|deposit|balance|lakh)\b|पैसे|रुपये|लाख|balance).*(\b(transfer|bhejo|bhejiye|karo|karna|karne|pay|jama)\b|ट्रांसफर|भेज|जमा|transfer)", re.I)),
    ("video_custody", re.compile(r"(call|video|कॉल|वीडियो)\s*(disconnect|cut|band|कट|काट|बंद|डिस्कनेक्ट)\s*(mat|मत)|disconnect\s*(mat|मत)|camera\s*(on|chalu|ऑन|चालू)\s*(rakh|रख)|कैमरा|call\s*पर\s*ही\s*रह|don'?t\s*(disconnect|hang up)", re.I)),
    ("secrecy_isolation", re.compile(r"(kisi|family|ghar|किसी|परिवार|घर).*(batana\s*mat|mat\s*batana|nahi\s*batana|बताना\s*मत|मत\s*बताना|नहीं\s*बताना)|confidential|गोपनीय|don'?t tell", re.I)),
    ("remote_access_request", re.compile(r"anydesk|teamviewer|quick\s*support|screen\s*share|app\s*(download|install)|ऐप\s*(डाउनलोड|install)", re.I)),
    ("channel_switch", re.compile(r"\b(whatsapp|skype|telegram)\b|व्हाट्सएप|स्काइप", re.I)),
    ("urgency_pressure", re.compile(r"\b(abhi|turant|immediately|jaldi|warna|otherwise)\b|तुरंत|वरना|जल्दी|अभी", re.I)),
    ("kyc_card_request", re.compile(r"\bkyc\b|card\s*(number|details)|aadhaar|pan\s*card|account\s*(number|details)|आधार|केवाईसी", re.I)),
    ("hook_story", re.compile(r"\b(parcel|courier|drugs|passport)\b|illegal\s*(items|saman)|पार्सल|ड्रग्स|पासपोर्ट", re.I)),
    ("link_request", re.compile(r"https?://|link\s*(par|pe)\s*click|click\s*(the|this)\s*link|लिंक", re.I)),
]
_AWARENESS = re.compile(r"\b(scams?|fraud|dhoka|savdhan|beware|awareness)\b|धोखा|सावधान|स्कैम", re.I)


class MockPipeline:
    name = "mock-keyword-placeholder"
    is_mock = True

    def __init__(self, rule_refs: dict[str, list[str]] | None = None):
        self._emit: dict[str, Emit] = {}
        self.rule_refs = rule_refs or {}

    async def start_session(self, session_id: str, emit: Emit) -> None:
        self._emit[session_id] = emit

    async def on_audio(self, session_id, event_id, chunk, pcm) -> None:
        return  # the mock has no ASR

    async def on_video(self, session_id, event_id, frame, jpeg) -> None:
        return

    async def on_chat(self, session_id, event_id, msg: ChatMessage) -> None:
        await self._detect(session_id, msg.text, [event_id], "chat", msg.t_ms, msg.t_ms)

    async def on_text(self, session_id, event_id, utt: Utterance) -> None:
        await self._detect(session_id, utt.text, [event_id], "speech", utt.t_start_ms, utt.t_end_ms)

    async def end_session(self, session_id: str) -> None:
        self._emit.pop(session_id, None)

    def health(self) -> dict:
        return {"ok": True, "detail": "MOCK: keyword placeholder on chat + injected text; no ASR"}

    async def _detect(self, session_id, text, refs, modality, t0, t1) -> None:
        emit = self._emit.get(session_id)
        if not emit:
            return
        quality = 0.3 if _AWARENESS.search(text) else 0.8
        for category, rx in _MOCK_RULES:
            m = rx.search(text)
            if not m:
                continue
            ev = Evidence(
                evidence_id=new_id("ev"),
                category=category,
                source_modality=modality,
                t_start_ms=t0,
                t_end_ms=t1,
                source_event_ids=refs,
                quoted_text_or_observation=text.strip(),
                quality=quality,
                rule_refs=self.rule_refs.get(category, []),
                is_mock=True,
            )
            await emit(make_event(session_id, "evidence", "model", ev))
