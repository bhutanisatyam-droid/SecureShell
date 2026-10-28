"""Canonical event contract v1.0 shared by the extension, backend and Shlok's AI pipeline.

Every message is an Envelope. Media (audio_chunk, video_frame) travels as a binary
WebSocket frame: 4-byte big-endian header length + UTF-8 JSON envelope + raw bytes
(see framing.py). Everything else is a JSON text frame holding just the envelope.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "1.0"

SpeakerRole = Literal["remote", "local", "unknown"]
Source = Literal["meet_tab", "local_mic", "meet_chat", "model", "policy", "extension", "dashboard"]
EventType = Literal[
    "audio_chunk", "video_frame", "chat_message", "utterance",
    "evidence", "retraction", "assessment", "action", "control",
]
RiskLevel = Literal["normal", "caution", "high", "critical"]
MonitoringState = Literal["ok", "degraded", "unavailable"]
InferenceMode = Literal["live", "mock", "none"]

LEVEL_ORDER: dict[str, int] = {"normal": 0, "caution": 1, "high": 2, "critical": 3}


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Envelope(_Strict):
    schema_version: Literal["1.0"] = SCHEMA_VERSION
    session_id: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,64}$")
    event_id: str = Field(min_length=1, max_length=128)
    event_type: EventType
    timestamp_ms: int
    source: Source
    payload: dict[str, Any]


class AudioChunk(_Strict):
    seq: int = Field(ge=0)
    t_start_ms: int
    t_end_ms: int
    sample_rate_hz: int = Field(gt=0)
    channels: int = Field(ge=1, le=2)
    encoding: Literal["pcm_s16le"]
    speaker_role: SpeakerRole


class VideoFrame(_Strict):
    seq: int = Field(ge=0)
    t_ms: int
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    encoding: Literal["jpeg"]


class ChatMessage(_Strict):
    message_id: str = Field(min_length=1, max_length=256)
    t_ms: int
    text: str = Field(max_length=4000)
    sender_role: SpeakerRole = "unknown"
    sender_label: str | None = None
    links: list[str] = []


class Utterance(_Strict):
    utterance_id: str = Field(min_length=1, max_length=128)
    t_start_ms: int
    t_end_ms: int
    text: str
    language_tags: list[str] = []
    speaker_role: SpeakerRole = "unknown"
    asr_quality: float | None = None
    is_final: bool = True
    is_mock: bool = False


class Evidence(_Strict):
    evidence_id: str = Field(min_length=1, max_length=128)
    category: str
    source_modality: Literal["speech", "chat", "video", "tone"]
    t_start_ms: int
    t_end_ms: int
    source_event_ids: list[str] = Field(min_length=1)
    quoted_text_or_observation: str = Field(min_length=1)
    quality: float | None = Field(default=None, ge=0.0, le=1.0)
    rule_refs: list[str] = []
    is_mock: bool = False


class Retraction(_Strict):
    """The model withdraws earlier evidence after later context showed it was not a direct
    act (e.g. it turned out to be a story, a lesson or a joke)."""
    retraction_id: str = Field(min_length=1, max_length=128)
    evidence_ids: list[str] = Field(min_length=1)
    reason: str = Field(min_length=1, max_length=300)


class Assessment(_Strict):
    assessment_id: str
    risk_index: int = Field(ge=0, le=100)
    risk_level: RiskLevel
    evidence_strength: Literal["none", "weak", "moderate", "strong"]
    evidence_ids: list[str]
    reasons: list[str]
    monitoring_state: MonitoringState
    categories: list[str] = []
    patterns: list[str] = []
    inference_mode: InferenceMode = "none"
    policy_gate: dict[str, bool] = {}
    latency_ms: dict[str, int] = {}
    config_version: str = ""


ActionType = Literal[
    "auto_disconnect", "manual_end_call", "close_tab_fallback", "bank_hold", "report_generated",
]
ActionStatus = Literal[
    "requested", "pending", "cancelled", "left_meet", "target_tab_closed",
    "failed", "unverified", "simulated", "done",
]


class Action(_Strict):
    action_id: str
    action_type: ActionType
    status: ActionStatus
    triggering_assessment_id: str | None = None
    details: dict[str, Any] = {}


class Control(_Strict):
    command: Literal["session_start", "session_stop", "heartbeat", "capture_status", "warning_shown"]
    details: dict[str, Any] = {}


PAYLOAD_MODELS: dict[str, type[BaseModel]] = {
    "audio_chunk": AudioChunk,
    "video_frame": VideoFrame,
    "chat_message": ChatMessage,
    "utterance": Utterance,
    "evidence": Evidence,
    "retraction": Retraction,
    "assessment": Assessment,
    "action": Action,
    "control": Control,
}


def parse_payload(env: Envelope) -> BaseModel:
    return PAYLOAD_MODELS[env.event_type].model_validate(env.payload)


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def make_event(session_id: str, event_type: str, source: str, payload: BaseModel | dict,
               event_id: str | None = None) -> Envelope:
    data = payload.model_dump() if isinstance(payload, BaseModel) else payload
    return Envelope(
        session_id=session_id,
        event_id=event_id or new_id(event_type),
        event_type=event_type,
        timestamp_ms=now_ms(),
        source=source,
        payload=data,
    )
