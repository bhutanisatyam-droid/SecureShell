"""Per-call session: ingest routing, bounded per-modality queues, AI pipeline calls,
evidence validation, fusion, policy, and pushes to extension + dashboard."""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from dataclasses import dataclass
from typing import Any

from fastapi import WebSocket
from pydantic import ValidationError

from . import framing
from .adapter import AIPipeline
from .bank import MockBank
from .contracts import (
    Action, Assessment, AudioChunk, ChatMessage, Control, Envelope, Evidence,
    Retraction, Utterance, VideoFrame, make_event, new_id, now_ms, parse_payload,
)
from .fusion import RiskConfig, RiskEngine
from .hub import Hub
from .policy import PolicyEngine
from .store import Store

log = logging.getLogger("callshield.session")

MAX_AUDIO_BYTES = 64 * 1024
MAX_VIDEO_BYTES = 2 * 1024 * 1024
AUDIO_STALE_MS = 5000
PIPELINE_ERROR_WINDOW_MS = 15000
ASSESSMENT_REFRESH_MS = 10000


@dataclass
class Deps:
    cfg: RiskConfig
    store: Store
    hub: Hub
    bank: MockBank
    pipeline: AIPipeline
    pipeline_timeout_s: float = 10.0


class Session:
    def __init__(self, session_id: str, deps: Deps):
        self.id = session_id
        self.d = deps
        self.created_ms = now_ms()
        self.ended_ms: int | None = None
        self.settings: dict[str, Any] = {}
        self.session_start_received = False
        self.ext_ws: WebSocket | None = None
        self.engine = RiskEngine(deps.cfg)
        self.policy = PolicyEngine(deps.cfg)
        self.counters: Counter = Counter()
        self.capture_status: dict[str, Any] = {}
        self.last_media_ms: dict[str, int] = {}
        self.last_pipeline_error_ms: int | None = None
        self.last_pipeline_error: str | None = None
        self.pipeline_started = False
        # event_id / utterance_id / message_id -> speaker role ("video" for frames)
        self.refs: dict[str, str] = {}
        self.latest: Assessment | None = None
        self._last_pushed_ms = 0
        self._lock = asyncio.Lock()
        self._audio_q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._video_q: asyncio.Queue = asyncio.Queue(maxsize=2)
        self._text_q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._tasks: list[asyncio.Task] = []

    # ---------- lifecycle ----------

    @property
    def active(self) -> bool:
        return self.ended_ms is None

    @property
    def inference_mode(self) -> str:
        if not self.pipeline_started:
            return "none"
        return "mock" if self.d.pipeline.is_mock else "live"

    async def start(self) -> None:
        self.d.store.upsert_session(self.id, self.created_ms, self.settings)
        try:
            await asyncio.wait_for(self.d.pipeline.start_session(self.id, self._emit),
                                   self.d.pipeline_timeout_s)
            self.pipeline_started = True
        except Exception as e:  # noqa: BLE001 - any pipeline failure means degraded monitoring
            self._pipeline_error("start_session", e)
        self._tasks = [
            asyncio.create_task(self._audio_worker()),
            asyncio.create_task(self._video_worker()),
            asyncio.create_task(self._text_worker()),
        ]

    async def stop(self) -> None:
        if not self.active:
            return
        self.ended_ms = now_ms()
        for t in self._tasks:
            t.cancel()
        try:
            await asyncio.wait_for(self.d.pipeline.end_session(self.id), self.d.pipeline_timeout_s)
        except Exception as e:  # noqa: BLE001
            self._pipeline_error("end_session", e)
        self.d.store.end_session(self.id, self.ended_ms)
        self._publish_health()

    # ---------- ingest from extension ----------

    async def handle_binary(self, data: bytes) -> None:
        try:
            header, body = framing.decode(data)
            env = Envelope.model_validate(header)
            payload = parse_payload(env)
        except (framing.FrameError, ValidationError) as e:
            self._reject("bad_binary_frame", e)
            return
        if env.session_id != self.id:
            self._reject("session_mismatch", env.session_id)
            return
        if isinstance(payload, AudioChunk):
            if len(body) > MAX_AUDIO_BYTES or len(body) % 2:
                self._reject("bad_audio_size", len(body))
                return
            key = "local_mic" if env.source == "local_mic" else "meet_tab"
            self.last_media_ms[key] = now_ms()
            self.counters[f"audio_chunks_{key}"] += 1
            self.refs[env.event_id] = payload.speaker_role
            self._put_dropping_oldest(self._audio_q, (env, payload, body), "audio_dropped")
        elif isinstance(payload, VideoFrame):
            if len(body) > MAX_VIDEO_BYTES:
                self._reject("bad_video_size", len(body))
                return
            self.last_media_ms["video"] = now_ms()
            self.counters["video_frames"] += 1
            self.refs[env.event_id] = "video"
            self._put_dropping_oldest(self._video_q, (env, payload, body), "video_dropped")
        else:
            self._reject("binary_wrong_type", env.event_type)

    async def handle_text(self, text: str) -> None:
        try:
            env = Envelope.model_validate_json(text)
            payload = parse_payload(env)
        except ValidationError as e:
            self._reject("bad_json_event", e)
            return
        if env.session_id != self.id:
            self._reject("session_mismatch", env.session_id)
            return

        if isinstance(payload, ChatMessage):
            if payload.message_id in self.refs:
                self.counters["chat_duplicates"] += 1
                return
            self.counters["chat_messages"] += 1
            self.refs[env.event_id] = payload.sender_role
            self.refs[payload.message_id] = payload.sender_role
            self._record(env)
            self._put_dropping_oldest(self._text_q, ("chat", env, payload), "text_dropped")
        elif isinstance(payload, Control):
            await self._handle_control(env, payload)
        elif isinstance(payload, Action) and env.source == "extension":
            # Outcome report for an action the extension executed (or refused to).
            self._record(env)
        else:
            self._reject("unexpected_event_from_extension", env.event_type)

    async def _handle_control(self, env: Envelope, c: Control) -> None:
        if c.command == "session_start":
            self.session_start_received = True
            self.settings = {k: c.details.get(k) for k in
                             ("auto_disconnect", "close_tab_fallback", "mic_enabled", "keep_chat_open",
                              "extension_version")}
            self.d.store.upsert_session(self.id, self.created_ms, self.settings)
            self._record(env)
        elif c.command == "session_stop":
            self._record(env)
            await self.stop()
        elif c.command in ("heartbeat", "capture_status"):
            self.capture_status = c.details
            self._publish_health()
        elif c.command == "warning_shown":
            shown = c.details.get("shown_at_ms")
            if self.latest and isinstance(shown, int) and c.details.get("assessment_id") == self.latest.assessment_id:
                c.details["assessment_to_warning_ms"] = shown - self._last_pushed_ms
            self._record(env)

    def inject_text(self, text: str, speaker_role: str = "remote") -> Envelope:
        """Debug / replay path: text as if it were a final ASR utterance. Marked is_mock."""
        t = now_ms()
        utt = Utterance(utterance_id=new_id("utt"), t_start_ms=t, t_end_ms=t, text=text,
                        speaker_role=speaker_role, is_mock=True)
        env = make_event(self.id, "utterance", "model", utt)
        self.refs[env.event_id] = speaker_role
        self.refs[utt.utterance_id] = speaker_role
        self._record(env)
        self._put_dropping_oldest(self._text_q, ("text", env, utt), "text_dropped")
        return env

    # ---------- workers (isolate modalities so video never stalls audio) ----------

    async def _audio_worker(self) -> None:
        while True:
            env, chunk, pcm = await self._audio_q.get()
            await self._call("on_audio", self.d.pipeline.on_audio(self.id, env.event_id, chunk, pcm))

    async def _video_worker(self) -> None:
        while True:
            env, frame, jpeg = await self._video_q.get()
            await self._call("on_video", self.d.pipeline.on_video(self.id, env.event_id, frame, jpeg))

    async def _text_worker(self) -> None:
        while True:
            kind, env, payload = await self._text_q.get()
            if kind == "chat":
                await self._call("on_chat", self.d.pipeline.on_chat(self.id, env.event_id, payload))
            else:
                await self._call("on_text", self.d.pipeline.on_text(self.id, env.event_id, payload))

    async def _call(self, what: str, coro) -> None:
        if not self.pipeline_started:
            coro.close()
            return
        try:
            await asyncio.wait_for(coro, self.d.pipeline_timeout_s)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self._pipeline_error(what, e)

    # ---------- events coming back from the AI pipeline ----------

    async def _emit(self, env: Envelope) -> None:
        if env.session_id != self.id or env.event_type not in ("utterance", "evidence", "retraction"):
            self._reject("pipeline_bad_event", f"{env.session_id}/{env.event_type}")
            return
        try:
            payload = parse_payload(env)
        except ValidationError as e:
            self._reject("pipeline_bad_payload", e)
            return
        if isinstance(payload, Retraction):
            removed = self.engine.retract(payload.evidence_ids)
            if not removed:
                self._reject("retraction_unknown_evidence", payload.evidence_ids)
                return
            env.payload["evidence_ids"] = removed
            self.counters["retractions"] += 1
            self._record(env)
            await self.reassess(force=True)
            return
        if isinstance(payload, Utterance):
            self.refs[env.event_id] = payload.speaker_role
            self.refs[payload.utterance_id] = payload.speaker_role
            self.counters["utterances"] += 1
            self._record(env)
            return
        assert isinstance(payload, Evidence)
        if payload.category not in self.d.cfg.categories:
            self._reject("unknown_evidence_category", payload.category)
            return
        roles = [self.refs.get(r) for r in payload.source_event_ids]
        if any(r is None for r in roles):
            self._reject("unresolved_evidence_ref", payload.source_event_ids)
            return
        speaker = self._speaker_for(roles)
        if not self.engine.add(payload, speaker):
            self.counters["evidence_duplicates"] += 1
            return
        self.counters["evidence"] += 1
        self._record(env)
        await self.reassess(force=True)

    @staticmethod
    def _speaker_for(roles: list[str]) -> str:
        people = [r for r in roles if r != "video"]
        if not people:
            return "unknown"
        if "remote" in people:
            return "remote"
        if all(r == "local" for r in people):
            return "local"
        return "unknown"

    # ---------- assessment + policy ----------

    def monitoring_state(self) -> str:
        t = now_ms()
        if not self.active or self.ext_ws is None or not self.pipeline_started:
            return "unavailable"
        try:
            healthy = bool(self.d.pipeline.health().get("ok"))
        except Exception:  # noqa: BLE001
            healthy = False
        if not healthy:
            return "unavailable"
        tab_audio = self.last_media_ms.get("meet_tab")
        if tab_audio is None or t - tab_audio > AUDIO_STALE_MS:
            return "degraded"
        if self.last_pipeline_error_ms and t - self.last_pipeline_error_ms < PIPELINE_ERROR_WINDOW_MS:
            return "degraded"
        return "ok"

    async def reassess(self, force: bool = False) -> Assessment:
        async with self._lock:
            t = now_ms()
            r = self.engine.assess(t)
            state = self.monitoring_state()
            gate, actions = self.policy.decide(
                r, settings=self.settings, monitoring_state=state,
                inference_mode=self.inference_mode, now_ms=t,
            )
            latency = {}
            if r.latest_text_evidence_end_ms:
                latency["evidence_end_to_assessment_ms"] = max(0, t - r.latest_text_evidence_end_ms)
            a = Assessment(
                assessment_id=new_id("asm"),
                risk_index=r.risk_index,
                risk_level=r.risk_level,
                evidence_strength=r.evidence_strength,
                evidence_ids=r.evidence_ids,
                reasons=r.reasons,
                monitoring_state=state,
                categories=r.categories,
                patterns=r.patterns,
                inference_mode=self.inference_mode,
                policy_gate=gate,
                latency_ms=latency,
                config_version=self.d.cfg.version,
            )
            changed = self._differs(a)
            if force or changed or t - self._last_pushed_ms >= ASSESSMENT_REFRESH_MS:
                self.latest = a
                self._last_pushed_ms = t
                env = make_event(self.id, "assessment", "policy", a)
                self._record(env)
                await self._send_ext(env)
            for req in actions:
                await self.issue_action(req.action_type, req.status, req.details, a.assessment_id)
            return a

    def _differs(self, a: Assessment) -> bool:
        p = self.latest
        return p is None or (p.risk_index, p.risk_level, p.monitoring_state, p.evidence_ids, p.policy_gate) != (
            a.risk_index, a.risk_level, a.monitoring_state, a.evidence_ids, a.policy_gate)

    async def issue_action(self, action_type: str, status: str, details: dict,
                           triggering_assessment_id: str | None) -> Envelope:
        if action_type == "bank_hold":
            claims = {
                "session_id": self.id,
                "assessment_id": triggering_assessment_id,
                "risk_index": self.latest.risk_index if self.latest else None,
                "risk_level": self.latest.risk_level if self.latest else None,
                "issued_ms": now_ms(),
            }
            details = details | {"attestation": self.d.bank.freeze(self.id, claims)}
        act = Action(action_id=new_id("act"), action_type=action_type, status=status,
                     triggering_assessment_id=triggering_assessment_id, details=details)
        env = make_event(self.id, "action", "policy", act)
        self._record(env)
        if action_type in ("auto_disconnect", "manual_end_call"):
            await self._send_ext(env)
        return env

    # ---------- plumbing ----------

    async def _send_ext(self, env: Envelope) -> None:
        ws = self.ext_ws
        if ws is None:
            self.counters["ext_send_skipped"] += 1
            return
        try:
            await ws.send_text(env.model_dump_json())
        except Exception as e:  # noqa: BLE001
            self.counters["ext_send_failed"] += 1
            log.warning("send to extension failed: %r", e)

    def _record(self, env: Envelope) -> None:
        self.d.store.add_event(env)
        self.d.hub.publish({"kind": "event", "session_id": self.id, "event": env.model_dump()})

    def _publish_health(self) -> None:
        self.d.hub.publish({"kind": "health", "session_id": self.id, "health": self.health()})

    def health(self) -> dict[str, Any]:
        t = now_ms()
        try:
            pipeline_health = self.d.pipeline.health()
        except Exception as e:  # noqa: BLE001
            pipeline_health = {"ok": False, "detail": repr(e)}
        return {
            "session_id": self.id,
            "active": self.active,
            "extension_connected": self.ext_ws is not None,
            "session_start_received": self.session_start_received,
            "monitoring_state": self.monitoring_state(),
            "inference_mode": self.inference_mode,
            "pipeline": {"name": self.d.pipeline.name, **pipeline_health,
                         "last_error": self.last_pipeline_error},
            "media_age_ms": {k: t - v for k, v in self.last_media_ms.items()},
            "capture_status": self.capture_status,
            "settings": self.settings,
            "counters": dict(self.counters),
            "queues": {"audio": self._audio_q.qsize(), "video": self._video_q.qsize(),
                       "text": self._text_q.qsize()},
            "bank_frozen": self.d.bank.is_frozen(self.id),
            "config_version": self.d.cfg.version,
        }

    def _put_dropping_oldest(self, q: asyncio.Queue, item, counter: str) -> None:
        while True:
            try:
                q.put_nowait(item)
                return
            except asyncio.QueueFull:
                try:
                    q.get_nowait()
                    self.counters[counter] += 1
                except asyncio.QueueEmpty:
                    pass

    def _reject(self, reason: str, detail: Any) -> None:
        self.counters[f"rejected_{reason}"] += 1
        log.warning("session %s rejected %s: %s", self.id, reason, str(detail)[:300])

    def _pipeline_error(self, what: str, e: BaseException) -> None:
        self.last_pipeline_error_ms = now_ms()
        self.last_pipeline_error = f"{what}: {e!r}"[:300]
        self.counters[f"pipeline_error_{what}"] += 1
        log.exception("pipeline %s failed", what, exc_info=e)


class SessionManager:
    def __init__(self, deps: Deps):
        self.d = deps
        self.sessions: dict[str, Session] = {}

    async def attach(self, session_id: str, ws: WebSocket) -> Session:
        s = self.sessions.get(session_id)
        if s is None or not s.active:
            s = Session(session_id, self.d)
            self.sessions[session_id] = s
            await s.start()
        old, s.ext_ws = s.ext_ws, ws
        if old is not None and old is not ws:
            try:
                await old.close(code=4409)
            except Exception:  # noqa: BLE001
                pass
        s._publish_health()
        return s

    async def detach(self, s: Session, ws: WebSocket) -> None:
        if s.ext_ws is ws:
            s.ext_ws = None
            s._publish_health()

    async def tick(self) -> None:
        for s in list(self.sessions.values()):
            if s.active:
                await s.reassess()
                s._publish_health()

    async def shutdown(self) -> None:
        for s in list(self.sessions.values()):
            await s.stop()
