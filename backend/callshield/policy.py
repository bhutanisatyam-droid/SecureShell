"""Action policy, kept separate from scoring.

The policy only *requests* actions. The extension executes an auto-disconnect only if the
user opted in locally as well, and only after a visible cancel window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .contracts import LEVEL_ORDER
from .fusion import RiskConfig, RiskResult


@dataclass
class ActionRequest:
    action_type: str
    status: str
    details: dict[str, Any] = field(default_factory=dict)


class PolicyEngine:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg
        self.critical_since_ms: int | None = None
        self.auto_disconnect_issued = False
        self.auto_disconnect_issued_ms = 0
        self.bank_hold_issued = False

    def gate(self, r: RiskResult, *, settings: dict, monitoring_state: str,
             inference_mode: str, now_ms: int) -> dict[str, bool]:
        ad = self.cfg.auto_disconnect
        sustained = (self.critical_since_ms is not None
                     and now_ms - self.critical_since_ms >= ad.sustain_ms)
        return {
            "user_opted_in": bool(settings.get("auto_disconnect")),
            "level_critical": r.risk_level == "critical",
            "sustained": sustained,
            "corroborated": len(r.text_categories) >= ad.min_text_categories,
            "strong_category": r.has_strong_category or not ad.require_strong_category,
            "monitoring_ok": monitoring_state == "ok",
            "live_inference": inference_mode == "live" or (inference_mode == "mock" and ad.allow_on_mock),
        }

    def decide(self, r: RiskResult, *, settings: dict, monitoring_state: str,
               inference_mode: str, now_ms: int) -> tuple[dict[str, bool], list[ActionRequest]]:
        if r.risk_level == "critical":
            if self.critical_since_ms is None:
                self.critical_since_ms = now_ms
        else:
            self.critical_since_ms = None

        actions: list[ActionRequest] = []

        if (not self.bank_hold_issued
                and LEVEL_ORDER[r.risk_level] >= LEVEL_ORDER[self.cfg.bank_hold_level]):
            self.bank_hold_issued = True
            actions.append(ActionRequest("bank_hold", "simulated",
                                         {"reason": f"risk level {r.risk_level}", "simulated": True}))

        checks = self.gate(r, settings=settings, monitoring_state=monitoring_state,
                           inference_mode=inference_mode, now_ms=now_ms)
        window = self.cfg.auto_disconnect.cancel_window_ms
        if all(checks.values()) and not self.auto_disconnect_issued:
            self.auto_disconnect_issued = True
            self.auto_disconnect_issued_ms = now_ms
            actions.append(ActionRequest("auto_disconnect", "pending",
                                         {"cancel_window_ms": window, "gate": checks}))
        elif (self.auto_disconnect_issued and r.risk_level != "critical"
              and now_ms - self.auto_disconnect_issued_ms < window):
            # Later context lowered the risk (e.g. evidence retracted) inside the cancel window.
            self.auto_disconnect_issued = False
            actions.append(ActionRequest("auto_disconnect", "cancelled",
                                         {"reason": "risk_revised", "risk_level": r.risk_level}))
        return checks, actions
