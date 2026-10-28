"""Live AI pipeline: Sarvam streaming ASR -> rolling Hinglish transcript -> Groq LLM
behaviour detector -> grounded `utterance` / `evidence` events.

Select with CALLSHIELD_PIPELINE=live (or leave unset with both keys present).
Needs SARVAM_API_KEY and GROQ_API_KEY. Vision and tone are not implemented here yet:
frames are accepted and ignored.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass, field

from ..adapter import _AWARENESS, _MOCK_RULES, Emit
from ..contracts import (
    AudioChunk, ChatMessage, Evidence, Retraction, Utterance, VideoFrame, make_event, new_id,
)
from .detector import GroqDetector, Line, Prior
from .sarvam_asr import SarvamStream

log = logging.getLogger("callshield.pipeline")

CONTEXT_LINES = 16
PRIOR_FINDINGS = 15
COALESCE_S = 0.15
ASR_FAIL_RAISE_AFTER_S = 3.0
FALLBACK_QUALITY = 0.4
_DEVANAGARI = re.compile(r"[ऀ-ॿ]")
_LATIN = re.compile(r"[A-Za-z]")


@dataclass
class _SessionState:
    session_id: str
    emit: Emit
    streams: dict[str, SarvamStream] = field(default_factory=dict)
    lines: list[Line] = field(default_factory=list)
    analyzed: int = 0
    prior: list[Prior] = field(default_factory=list)
    evidence_by_line: dict[str, list[str]] = field(default_factory=dict)
    dirty: bool = False
    task: asyncio.Task | None = None
    pending_error: Exception | None = None
    last_call: float = 0.0
    last_asr_raise: float = 0.0


class LivePipeline:
    is_mock = False

    def __init__(self):
        self.sarvam_key = os.environ.get("SARVAM_API_KEY", "")
        self.groq_key = os.environ.get("GROQ_API_KEY", "")
        self.asr_model = os.environ.get("CALLSHIELD_ASR_MODEL", "saaras:v4")
        models = os.environ.get("CALLSHIELD_LLM_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b")
        self.llm_models = tuple(m.strip() for m in models.split(",") if m.strip())
        self.min_interval_s = float(os.environ.get("CALLSHIELD_LLM_MIN_INTERVAL_S", "2.5"))
        self.name = f"sarvam-{self.asr_model}+groq-{self.llm_models[0]}"
        self.rule_refs: dict[str, list[str]] = {}
        self.detector: GroqDetector | None = None
        self._s: dict[str, _SessionState] = {}

    def configure(self, cfg) -> None:
        text_cats = {k for k, v in cfg.categories.items() if v.modality == "text"}
        self.rule_refs = {k: v.rules for k, v in cfg.categories.items()}
        self.detector = GroqDetector(self.groq_key, models=self.llm_models, allowed_categories=text_cats)

    # ---------- AIPipeline interface ----------

    async def start_session(self, session_id: str, emit: Emit) -> None:
        if not (self.sarvam_key and self.groq_key):
            raise RuntimeError("SARVAM_API_KEY and GROQ_API_KEY are required for the live pipeline")
        if self.detector is None:
            raise RuntimeError("pipeline not configured")
        self._s[session_id] = _SessionState(session_id, emit)

    async def on_audio(self, session_id: str, event_id: str, chunk: AudioChunk, pcm: bytes) -> None:
        st = self._s.get(session_id)
        if st is None:
            return
        self._raise_pending(st)
        role = chunk.speaker_role
        stream = st.streams.get(role)
        if stream is None:
            stream = SarvamStream(
                self.sarvam_key, self._on_final_factory(session_id, role),
                label=f"{session_id}/{role}", model=self.asr_model, sample_rate=chunk.sample_rate_hz,
            )
            st.streams[role] = stream
            stream.start()
        stream.push(pcm, chunk.t_start_ms, chunk.t_end_ms)
        if stream.failing_for_s() > ASR_FAIL_RAISE_AFTER_S and time.monotonic() - st.last_asr_raise > ASR_FAIL_RAISE_AFTER_S:
            st.last_asr_raise = time.monotonic()
            raise RuntimeError(f"ASR stream {role} down: {stream.error}")

    async def on_video(self, session_id: str, event_id: str, frame: VideoFrame, jpeg: bytes) -> None:
        return  # vision not implemented in the live pipeline yet

    async def on_chat(self, session_id: str, event_id: str, msg: ChatMessage) -> None:
        st = self._s.get(session_id)
        if st is None:
            return
        self._raise_pending(st)
        text = msg.text
        extra = [u for u in msg.links if u not in text]
        if extra:
            text += " " + " ".join(extra)
        self._add_line(st, Line(event_id, msg.sender_role, "chat", text, msg.t_ms, msg.t_ms))

    async def on_text(self, session_id: str, event_id: str, utt: Utterance) -> None:
        st = self._s.get(session_id)
        if st is None:
            return
        self._raise_pending(st)
        self._add_line(st, Line(event_id, utt.speaker_role, "speech", utt.text, utt.t_start_ms, utt.t_end_ms))

    async def end_session(self, session_id: str) -> None:
        st = self._s.pop(session_id, None)
        if st is None:
            return
        if st.task:
            st.task.cancel()
        for s in st.streams.values():
            await s.close()

    def health(self) -> dict:
        if not (self.sarvam_key and self.groq_key):
            return {"ok": False, "detail": "missing SARVAM_API_KEY or GROQ_API_KEY"}
        d = self.detector.stats if self.detector else None
        streams = {f"{sid}/{role}": ("up" if s.connected else f"down: {s.error}")
                   for sid, st in self._s.items() for role, s in st.streams.items()}
        return {
            "ok": True,
            "detail": f"ASR {self.asr_model} codemix hi-IN; LLM {', '.join(self.llm_models)}",
            "asr_streams": streams,
            "llm": None if d is None else {
                "calls": d.calls, "failures": d.failures, "last_latency_ms": d.last_latency_ms,
                "last_model": d.last_model, "dropped": d.dropped, "tokens": d.tokens,
                "skipped_by_prefilter": d.skipped_by_prefilter,
            },
        }

    # ---------- internals ----------

    @staticmethod
    def _raise_pending(st: _SessionState) -> None:
        if st.pending_error is not None:
            e, st.pending_error = st.pending_error, None
            raise RuntimeError(f"detector failed, rule fallback used: {e!r}")

    def _on_final_factory(self, session_id: str, role: str):
        async def on_final(text: str, t0: int, t1: int, lang: str | None) -> None:
            st = self._s.get(session_id)
            if st is None:
                return
            tags = (["hi"] if _DEVANAGARI.search(text) else []) + (["en"] if _LATIN.search(text) else [])
            utt = Utterance(utterance_id=new_id("utt"), t_start_ms=t0, t_end_ms=t1, text=text,
                            language_tags=tags or ([lang] if lang else []), speaker_role=role,
                            asr_quality=None, is_final=True)
            env = make_event(session_id, "utterance", "model", utt)
            await st.emit(env)
            self._add_line(st, Line(env.event_id, role, "speech", text, t0, t1))
        return on_final

    def _add_line(self, st: _SessionState, line: Line) -> None:
        st.lines.append(line)
        if line.role == "local":
            return  # context only; the next remote line will be analysed with it
        st.dirty = True
        if st.task is None or st.task.done():
            st.task = asyncio.create_task(self._analysis_loop(st))

    async def _analysis_loop(self, st: _SessionState) -> None:
        while st.dirty:
            st.dirty = False
            # Batch: lines arriving within the interval share one LLM call (token budget).
            wait = max(COALESCE_S, self.min_interval_s - (time.monotonic() - st.last_call))
            await asyncio.sleep(wait)
            st.last_call = time.monotonic()
            new = st.lines[st.analyzed:]
            st.analyzed = len(st.lines)
            if not any(l.role != "local" for l in new):
                continue
            context = st.lines[-max(CONTEXT_LINES, len(new)):]
            in_context = {l.line_id for l in context}
            prior = [p for p in st.prior if p.line_id in in_context][-PRIOR_FINDINGS:]
            retract: dict[str, str] = {}
            try:
                analysis = await self.detector.analyze(context, new, prior)
                results = [(f.line, f.category, f.quote, f.confidence) for f in analysis.findings]
                retract = analysis.retract
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - degrade to rules, surface the error to the session
                log.warning("detector failed, using rule fallback: %r", e)
                st.pending_error = e
                results = self._fallback(new)
            for line_id, reason in retract.items():
                ids = st.evidence_by_line.pop(line_id, [])
                st.prior = [p for p in st.prior if p.line_id != line_id]
                if ids:
                    r = Retraction(retraction_id=new_id("ret"), evidence_ids=ids, reason=reason)
                    await st.emit(make_event(st.session_id, "retraction", "model", r))
            for line, cat, quote, quality in results:
                ev = Evidence(
                    evidence_id=new_id("ev"), category=cat,
                    source_modality="chat" if line.source == "chat" else "speech",
                    t_start_ms=line.t_start_ms, t_end_ms=line.t_end_ms,
                    source_event_ids=[line.line_id], quoted_text_or_observation=quote,
                    quality=round(quality, 3), rule_refs=self.rule_refs.get(cat, []),
                )
                st.prior.append(Prior(line.line_id, cat, quote))
                st.evidence_by_line.setdefault(line.line_id, []).append(ev.evidence_id)
                await st.emit(make_event(st.session_id, "evidence", "model", ev))

    @staticmethod
    def _fallback(new: list[Line]) -> list[tuple[Line, str, str, float]]:
        out = []
        for line in new:
            if line.role == "local" or _AWARENESS.search(line.text):
                continue
            for cat, rx in _MOCK_RULES:
                if rx.search(line.text):
                    out.append((line, cat, line.text, FALLBACK_QUALITY))
        return out
