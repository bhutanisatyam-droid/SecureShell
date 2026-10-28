import pytest

from callshield.contracts import Evidence
from callshield.fusion import RiskEngine, load_risk_config
from callshield.policy import PolicyEngine

T0 = 1_000_000


@pytest.fixture
def cfg():
    return load_risk_config()


def ev(i, category, text="x", t=T0, quality=0.9, modality="speech"):
    return Evidence(evidence_id=f"ev{i}", category=category, source_modality=modality,
                    t_start_ms=t, t_end_ms=t, source_event_ids=[f"e{i}"],
                    quoted_text_or_observation=text, quality=quality)


def test_empty_is_normal(cfg):
    r = RiskEngine(cfg).assess(T0)
    assert r.risk_index == 0 and r.risk_level == "normal" and r.evidence_strength == "none"


def test_digital_arrest_pattern_is_critical(cfg):
    eng = RiskEngine(cfg)
    eng.add(ev(1, "authority_claim", "Main Mumbai Police se baat kar raha hoon"), "remote")
    eng.add(ev(2, "digital_arrest_claim", "Aap digital arrest mein hain"), "remote")
    eng.add(ev(3, "video_custody", "call disconnect mat karna"), "remote")
    eng.add(ev(4, "payment_demand", "verification ke liye paise transfer karne padenge"), "remote")
    r = eng.assess(T0)
    assert r.risk_level == "critical"
    assert "digital_arrest" in r.patterns
    assert r.evidence_strength == "strong"
    assert any("R13" in reason for reason in r.reasons)


def test_victim_speech_does_not_count(cfg):
    eng = RiskEngine(cfg)
    eng.add(ev(1, "digital_arrest_claim", "maine digital arrest scam ke baare mein suna"), "local")
    eng.add(ev(2, "credential_request", "mujhe OTP aaya hai"), "local")
    assert eng.assess(T0).risk_index == 0


def test_repeats_do_not_stack(cfg):
    eng = RiskEngine(cfg)
    eng.add(ev(1, "payment_demand", "paise transfer karo"), "remote")
    one = eng.assess(T0).risk_index
    assert eng.add(ev(2, "payment_demand", "paise transfer karo", t=T0 + 1000), "remote") is False
    eng.add(ev(3, "payment_demand", "abhi paise bhejo", t=T0 + 2000), "remote")
    assert eng.assess(T0 + 2000).risk_index == one


def test_weak_only_is_capped(cfg):
    eng = RiskEngine(cfg)
    for i, c in enumerate(["hook_story", "link_request", "unsolicited_pressure", "authority_claim"]):
        eng.add(ev(i, c, f"t{i}", quality=1.0), "remote")
    r = eng.assess(T0)
    assert r.risk_index <= int(cfg.weak_only_cap * 100)


def test_video_and_tone_alone_cannot_raise_risk(cfg):
    eng = RiskEngine(cfg)
    eng.add(ev(1, "visual_uniform", "uniform", modality="video", quality=1.0), "unknown")
    eng.add(ev(2, "tone_intimidation", "angry", modality="tone", quality=1.0), "unknown")
    r = eng.assess(T0)
    assert r.risk_index == 0
    assert any("not counted" in x for x in r.reasons)


def _critical_result(cfg):
    eng = RiskEngine(cfg)
    for i, c in enumerate(["authority_claim", "digital_arrest_claim", "video_custody", "payment_demand"]):
        eng.add(ev(i, c, f"t{i}"), "remote")
    return eng.assess(T0)


def _run_policy(cfg, r, settings, state="ok", mode="live", duration_ms=10_000):
    p = PolicyEngine(cfg)
    fired = []
    for t in range(T0, T0 + duration_ms + 1, 2000):
        _, acts = p.decide(r, settings=settings, monitoring_state=state, inference_mode=mode, now_ms=t)
        fired += [a.action_type for a in acts]
    return fired


def test_auto_disconnect_requires_opt_in(cfg):
    r = _critical_result(cfg)
    assert "auto_disconnect" not in _run_policy(cfg, r, {"auto_disconnect": False})
    assert _run_policy(cfg, r, {"auto_disconnect": True}).count("auto_disconnect") == 1


def test_auto_disconnect_requires_sustained_critical(cfg):
    r = _critical_result(cfg)
    assert "auto_disconnect" not in _run_policy(cfg, r, {"auto_disconnect": True}, duration_ms=2000)


def test_auto_disconnect_blocked_when_degraded_or_mock(cfg):
    cfg.auto_disconnect.allow_on_mock = False
    r = _critical_result(cfg)
    assert "auto_disconnect" not in _run_policy(cfg, r, {"auto_disconnect": True}, state="degraded")
    assert "auto_disconnect" not in _run_policy(cfg, r, {"auto_disconnect": True}, mode="mock")


def test_bank_hold_once_at_high(cfg):
    r = _critical_result(cfg)
    assert _run_policy(cfg, r, {}).count("bank_hold") == 1
