import asyncio

import pytest

from callshield.ai.detector import GroqDetector, Line, Prior, is_candidate
from callshield.ai.pipeline import LivePipeline
from callshield.contracts import Utterance
from callshield.fusion import load_risk_config


def line(i, role="remote", text="Aap digital arrest mein hain, paise transfer karo"):
    return Line(f"L{i}", role, "speech", text, 0, 0)


@pytest.fixture
def det():
    return GroqDetector("k", allowed_categories=set(load_risk_config().categories))


def test_validate_grounding_rules(det):
    targets = {"L1": line(1), "L2": line(2, text="Mujhe OTP aaya hai")}
    out = {"lines": [
        {"line_id": "L1", "speech_act": "direct", "findings": [
            {"category": "digital_arrest_claim", "quote": "digital arrest", "confidence": 0.9},
            {"category": "payment_demand", "quote": "invented words", "confidence": 2},
            {"category": "made_up", "quote": "x", "confidence": 0.9}]},
        {"line_id": "L9", "speech_act": "direct", "findings": [{"category": "legal_threat", "quote": "x"}]},
        {"line_id": "L2", "speech_act": "educational", "findings": [{"category": "credential_request", "quote": "OTP"}]},
    ]}
    fs = det.validate(out, targets)
    assert [(f.category, f.quote_exact) for f in fs] == [("digital_arrest_claim", True), ("payment_demand", False)]
    assert fs[1].quote == targets["L1"].text  # non-verbatim quote replaced by the real line
    assert fs[1].confidence == 1.0
    assert det.stats.dropped == {"quote_not_verbatim_used_line": 1, "unknown_category": 1,
                                 "unknown_or_local_line": 1, "speech_act_educational": 1}


def test_prefilter():
    assert is_candidate("आप digital arrest में हैं call disconnect मत करना।")
    assert is_candidate("jo code aaya hai woh boliye")
    assert not is_candidate("Haan ji, boliye")


def test_local_lines_never_analyzed(det):
    async def boom(_):
        raise AssertionError("LLM must not be called")
    det._complete = boom
    assert asyncio.run(det.analyze([line(1, "local")], [line(1, "local")], [])).findings == []
    assert asyncio.run(det.analyze([line(2, text="Haan ji")], [line(2, text="Haan ji")], [])).findings == []


def test_retract_only_known_earlier_lines(det):
    prior = [Prior("L1", "video_custody", "camera on rakho")]
    out = {"retract": [{"line_id": "L1", "reason": "part of a lesson"}, {"line_id": "L7", "reason": "x"},
                       {"line_id": "L2", "reason": "current line"}]}
    assert det.validate_retract(out, prior, {"L2": line(2)}) == {"L1": "part of a lesson"}


def _pipeline(monkeypatch, findings=None, fail=False):
    monkeypatch.setenv("SARVAM_API_KEY", "s")
    monkeypatch.setenv("GROQ_API_KEY", "g")
    p = LivePipeline()
    p.configure(load_risk_config())

    async def complete(user):
        if fail:
            raise RuntimeError("groq down")
        lid = user.split("<analyze>\n")[1].split("\n")[0].split(", ")[-1]
        return {"lines": [{"line_id": lid, "speech_act": "direct", "findings": findings or []}]}
    p.detector._complete = complete
    return p


def test_pipeline_emits_grounded_evidence(monkeypatch):
    p = _pipeline(monkeypatch, [{"category": "digital_arrest_claim", "quote": "digital arrest", "confidence": 0.8}])
    emitted = []

    async def run():
        async def emit(env):
            emitted.append(env)
        await p.start_session("s1", emit)
        utt = Utterance(utterance_id="u1", t_start_ms=1, t_end_ms=2, text="Aap digital arrest mein hain", speaker_role="remote")
        await p.on_text("s1", "utterance-1", utt)
        await asyncio.sleep(0.4)
        await p.end_session("s1")
    asyncio.run(run())
    ev = [e for e in emitted if e.event_type == "evidence"]
    assert len(ev) == 1
    assert ev[0].payload["source_event_ids"] == ["utterance-1"]
    assert ev[0].payload["rule_refs"] == ["R13"]
    assert ev[0].payload["is_mock"] is False


def test_pipeline_falls_back_to_rules_and_reports(monkeypatch):
    p = _pipeline(monkeypatch, fail=True)
    emitted = []

    async def run():
        async def emit(env):
            emitted.append(env)
        await p.start_session("s1", emit)
        utt = Utterance(utterance_id="u1", t_start_ms=1, t_end_ms=2, text="Aap digital arrest mein hain", speaker_role="remote")
        await p.on_text("s1", "utterance-1", utt)
        await asyncio.sleep(0.4)
        with pytest.raises(RuntimeError, match="rule fallback"):
            await p.on_text("s1", "utterance-2", utt)
        await p.end_session("s1")
    asyncio.run(run())
    ev = [e.payload for e in emitted if e.event_type == "evidence"]
    assert ev and all(e["quality"] == 0.4 for e in ev)
