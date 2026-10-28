"""Deterministic evidence fusion: evidence ledger -> reproducible risk index (not a probability).

Values (weights, thresholds, patterns) come from risk_config.yaml, owned by Shlok.
This module only enforces them. It never triggers actions; see policy.py.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, model_validator

from .contracts import Evidence

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "risk_config.yaml"


class CategoryCfg(BaseModel):
    label: str
    modality: Literal["text", "video", "tone"]
    weight: float
    strength: Literal["weak", "normal", "strong"] = "normal"
    rules: list[str] = []


class PatternCfg(BaseModel):
    name: str
    label: str
    groups: list[list[str]]
    min_groups: int
    bonus: float


class ModalityCaps(BaseModel):
    video: float
    tone: float
    require_text_risk: float


class LevelsCfg(BaseModel):
    caution: int
    high: int
    critical: int


class AutoDisconnectCfg(BaseModel):
    min_text_categories: int
    require_strong_category: bool
    sustain_ms: int
    cancel_window_ms: int
    allow_on_mock: bool = False


class RiskConfig(BaseModel):
    version: str
    combine: Literal["noisy_or", "additive"]
    decay_half_life_s: float
    speaker_factor: dict[str, float]
    dedupe_window_ms: int
    weak_only_cap: float
    single_category_cap: float = 1.0
    categories: dict[str, CategoryCfg]
    modality_caps: ModalityCaps
    patterns: list[PatternCfg]
    levels: LevelsCfg
    auto_disconnect: AutoDisconnectCfg
    bank_hold_level: Literal["caution", "high", "critical"] = "high"

    @model_validator(mode="after")
    def _check_refs(self):
        for p in self.patterns:
            for g in p.groups:
                for c in g:
                    if c not in self.categories:
                        raise ValueError(f"pattern {p.name} references unknown category {c}")
        return self


def load_risk_config(path: str | Path | None = None) -> RiskConfig:
    with open(path or DEFAULT_CONFIG_PATH, encoding="utf-8") as f:
        return RiskConfig.model_validate(yaml.safe_load(f))


@dataclass
class LedgerEntry:
    evidence: Evidence
    speaker_role: str


@dataclass
class RiskResult:
    risk_index: int
    risk_level: str
    evidence_strength: str
    evidence_ids: list[str]
    reasons: list[str]
    categories: list[str]
    text_categories: list[str]
    patterns: list[str]
    has_strong_category: bool
    latest_text_evidence_end_ms: int | None = None
    contributions: dict[str, float] = field(default_factory=dict)


_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _WS.sub(" ", text.strip().lower())


class RiskEngine:
    MIN_CONTRIBUTION = 0.01

    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg
        self.entries: dict[str, LedgerEntry] = {}
        self._recent: dict[tuple[str, str], int] = {}

    def add(self, ev: Evidence, speaker_role: str) -> bool:
        """Returns False when the evidence is a duplicate and was not added."""
        if ev.category not in self.cfg.categories:
            raise ValueError(f"unknown category {ev.category}")
        if ev.evidence_id in self.entries:
            return False
        key = (ev.category, _norm(ev.quoted_text_or_observation))
        last = self._recent.get(key)
        if last is not None and abs(ev.t_end_ms - last) <= self.cfg.dedupe_window_ms:
            return False
        self._recent[key] = ev.t_end_ms
        self.entries[ev.evidence_id] = LedgerEntry(ev, speaker_role)
        return True

    def retract(self, evidence_ids: list[str]) -> list[str]:
        """Removes evidence from scoring. Returns the ids that were actually present."""
        removed = [i for i in evidence_ids if self.entries.pop(i, None) is not None]
        return removed

    def _contribution(self, e: LedgerEntry, now_ms: int) -> float:
        cat = self.cfg.categories[e.evidence.category]
        quality = 1.0 if e.evidence.quality is None else e.evidence.quality
        speaker = self.cfg.speaker_factor.get(e.speaker_role, 0.0) if cat.modality == "text" else 1.0
        age_s = max(0.0, (now_ms - e.evidence.t_end_ms) / 1000)
        hl = self.cfg.decay_half_life_s
        decay = math.pow(0.5, age_s / hl) if hl > 0 else 1.0
        return cat.weight * quality * speaker * decay

    def _combine(self, values: list[float]) -> float:
        if self.cfg.combine == "additive":
            return min(1.0, sum(values))
        p = 1.0
        for v in values:
            p *= 1.0 - min(1.0, v)
        return 1.0 - p

    def level_for(self, risk_index: int) -> str:
        lv = self.cfg.levels
        if risk_index >= lv.critical:
            return "critical"
        if risk_index >= lv.high:
            return "high"
        if risk_index >= lv.caution:
            return "caution"
        return "normal"

    def assess(self, now_ms: int) -> RiskResult:
        cfg = self.cfg
        # One contribution per category: repeated mentions never stack.
        best: dict[str, tuple[float, LedgerEntry]] = {}
        for e in self.entries.values():
            c = self._contribution(e, now_ms)
            if c < self.MIN_CONTRIBUTION:
                continue
            cur = best.get(e.evidence.category)
            if cur is None or c > cur[0]:
                best[e.evidence.category] = (c, e)

        text = {k: v for k, v in best.items() if cfg.categories[k].modality == "text"}
        other = {k: v for k, v in best.items() if cfg.categories[k].modality != "text"}

        text_risk = self._combine([v for v, _ in text.values()])

        modifier = 0.0
        modifiers_applied = text_risk >= cfg.modality_caps.require_text_risk
        if modifiers_applied:
            for modality in ("video", "tone"):
                s = sum(v for k, (v, _) in other.items() if cfg.categories[k].modality == modality)
                modifier += min(s, getattr(cfg.modality_caps, modality))

        matched: list[PatternCfg] = []
        for p in cfg.patterns:
            hits = sum(1 for g in p.groups if any(c in text for c in g))
            if hits >= p.min_groups:
                matched.append(p)

        risk = text_risk + modifier + sum(p.bonus for p in matched)
        weak_only = bool(text) and all(cfg.categories[k].strength == "weak" for k in text)
        if weak_only:
            risk = min(risk, cfg.weak_only_cap)
        if len(text) <= 1:
            risk = min(risk, cfg.single_category_cap)
        risk = max(0.0, min(1.0, risk))
        risk_index = int(round(risk * 100))

        has_strong = any(cfg.categories[k].strength == "strong" for k in text)
        n = len(text)
        if n == 0:
            strength = "none"
        elif n >= 3:
            strength = "strong"
        elif n == 2 or has_strong:
            strength = "moderate"
        else:
            strength = "weak"

        reasons: list[str] = []
        for p in matched:
            reasons.append(f"Pattern: {p.label}")
        for k, (v, e) in sorted(text.items(), key=lambda kv: -kv[1][0]):
            cat = cfg.categories[k]
            refs = f" [{', '.join(cat.rules)}]" if cat.rules else ""
            quote = e.evidence.quoted_text_or_observation
            if len(quote) > 140:
                quote = quote[:137] + "..."
            reasons.append(f"{cat.label}{refs}: “{quote}”")
        for k, (v, e) in other.items():
            cat = cfg.categories[k]
            note = "" if modifiers_applied else " (not counted: no corroborating speech/chat)"
            reasons.append(f"Supporting {cat.modality} cue: {cat.label}{note}")

        contributing = [e.evidence.evidence_id for _, e in text.values()]
        if modifiers_applied:
            contributing += [e.evidence.evidence_id for _, e in other.values()]

        latest_text_end = max((e.evidence.t_end_ms for _, e in text.values()), default=None)

        return RiskResult(
            risk_index=risk_index,
            risk_level=self.level_for(risk_index),
            evidence_strength=strength,
            evidence_ids=contributing,
            reasons=reasons,
            categories=sorted(best),
            text_categories=sorted(text),
            patterns=[p.name for p in matched],
            has_strong_category=has_strong,
            latest_text_evidence_end_ms=latest_text_end,
            contributions={k: round(v, 4) for k, (v, _) in best.items()},
        )
