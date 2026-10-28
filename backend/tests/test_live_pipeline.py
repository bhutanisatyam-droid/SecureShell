import asyncio

import pytest

import httpx

from callshield.ai.detector import LLMBackend, LLMDetector, Line, Prior, _parse_duration_s, is_candidate
from callshield.ai.pipeline import LivePipeline
from callshield.contracts import Utterance
from callshield.fusion import load_risk_config


def line(i, role="remote", text="Aap digital arrest mein hain, paise transfer karo"):
    return Line(f"L{i}", role, "speech", text, 0, 0)


@pytest.fixture
def det():
    return LLMDetector([LLMBackend("groq", "m", "k", "GROQ_API_KEY")],
                       allowed_categories=set(load_risk_config().categories))


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


def test_failover_to_next_backend_on_429(det):
    det.backends = [LLMBackend("groq", "openai/gpt-oss-120b", "g", "GROQ_API_KEY"),
                    LLMBackend("gemini", "gemini-flash-lite-latest", "m", "GEMINI_API_KEY")]
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.host)
        if "groq" in req.url.host:
            return httpx.Response(429, headers={"retry-after": "30"}, json={"error": {"message": "rate limit"}})
        assert req.headers["authorization"] == "Bearer m"
        content = '```json\n{"lines": []}\n```'  # fenced JSON is tolerated
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}], "usage": {"total_tokens": 10}})

    det._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert asyncio.run(det._complete("x")) == {"lines": []}
    assert asyncio.run(det._complete("x")) == {"lines": []}
    # the rate-limited backend is skipped on the second call instead of being retried
    assert seen == ["api.groq.com", "generativelanguage.googleapis.com", "generativelanguage.googleapis.com"]
    status = {s["backend"]: s for s in det.backend_status()}
    assert status["groq:openai/gpt-oss-120b"]["state"].startswith("cooling")
    assert det.stats.last_model == "gemini:gemini-flash-lite-latest"


def test_all_backends_limited_raises_rate_limited(det):
    from callshield.ai.detector import RateLimited
    det._client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda req: httpx.Response(429, text="quota exceeded per day")))
    with pytest.raises(RateLimited):
        asyncio.run(det._complete("x"))
    assert det.backends[0].limited_until - __import__("time").monotonic() > 600  # daily quota -> long cooldown


def test_parse_groq_reset_durations():
    assert _parse_duration_s("7.66s") == pytest.approx(7.66)
    assert _parse_duration_s("1m26.4s") == pytest.approx(86.4)
    assert _parse_duration_s("134ms") == pytest.approx(0.134)
    assert _parse_duration_s("15m50.4s") == pytest.approx(950.4)
    assert _parse_duration_s("") is None


def test_failing_backend_is_rested(det):
    det.backends = [LLMBackend("groq", "a", "bad", "GROQ_API_KEY"), LLMBackend("gemini", "b", "m", "GEMINI_API_KEY")]
    seen = []

    def handler(req):
        seen.append(req.url.host)
        if "groq" in req.url.host:
            return httpx.Response(401, json={"error": {"message": "invalid key"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"lines": []}'}}]})

    det._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    asyncio.run(det._complete("x"))
    asyncio.run(det._complete("x"))
    assert seen.count("api.groq.com") == 1  # not retried on the second call


def _vision_pipeline(monkeypatch, observations):
    monkeypatch.setenv("SARVAM_API_KEY", "s")
    monkeypatch.setenv("GROQ_API_KEY", "g")
    monkeypatch.setenv("GEMINI_API_KEY", "m")
    p = LivePipeline()
    p.configure(load_risk_config())
    calls = []

    async def analyze(jpeg):
        from callshield.ai.vision import FrameObservation
        calls.append(jpeg)
        return FrameObservation(**observations[min(len(calls), len(observations)) - 1])
    p.vision.analyze = analyze
    lines = []

    async def no_llm(user):  # record what the text detector would see
        lines.append(user)
        return {"lines": []}
    p.detector._complete = no_llm
    return p, calls, lines


def _frame(seq, change):
    from callshield.contracts import VideoFrame
    return VideoFrame(seq=seq, t_ms=1000 + seq, width=1280, height=720, encoding="jpeg", change_score=change)


def test_vision_gating_and_document_text_reaches_detector(monkeypatch):
    import callshield.ai.pipeline as P
    monkeypatch.setattr(P, "VISION_MIN_INTERVAL_S", 0.0)
    doc = {"documents": [{"kind": "warrant", "text": "ARREST WARRANT pay Rs 2,00,000 within 1 hour", "agency": "CCB"}],
           "cues": ["police_style_uniform"], "confidence": 0.9}
    p, calls, seen_by_llm = _vision_pipeline(monkeypatch, [doc])
    emitted = []

    async def run():
        async def emit(env):
            emitted.append(env)
        await p.start_session("s1", emit)
        await p.on_video("s1", "f0", _frame(0, None), b"a")    # first frame: periodic check
        await asyncio.sleep(0.05)
        await p.on_video("s1", "f1", _frame(1, 0.01), b"b")    # static: nothing new
        await p.on_video("s1", "f2", _frame(2, 0.30), b"c")    # card raised: moving, wait
        await p.on_video("s1", "f3", _frame(3, 0.005), b"d")   # settled: analyse
        await asyncio.sleep(0.05)
        await p.on_video("s1", "f4", _frame(4, 0.30), b"e")
        await p.on_video("s1", "f5", _frame(5, 0.005), b"f")   # same card again
        await asyncio.sleep(3.0)                                # let the batched text call run
        assert p.latest_frame("s1")["event_id"] == "f5"
        await p.end_session("s1")
    asyncio.run(run())
    assert calls == [b"a", b"d", b"f"]
    ev = [e.payload for e in emitted if e.event_type == "evidence"]
    # uniform + document cue once each (no re-emit within a minute), sourced from the frame
    assert sorted(e["category"] for e in ev) == ["visual_official_document", "visual_uniform"]
    assert all(e["source_modality"] == "video" for e in ev)
    # the warrant text went to the text detector exactly once despite being seen three times
    joined = "\n".join(seen_by_llm)
    assert joined.count("ARREST WARRANT") >= 1 and "(screen)" in joined
    assert sum(u.count("[warrant from CCB shown on video]") > 0 for u in seen_by_llm) >= 1


def test_vision_validate_drops_unknown_kinds_and_cues():
    from callshield.ai.vision import GeminiVision
    o = GeminiVision.validate({"documents": [{"kind": "warrant", "text": "x"}, {"kind": "selfie"}],
                               "cues": ["police_style_uniform", "looks_fake"], "confidence": "high"})
    assert [d["kind"] for d in o.documents] == ["warrant"]
    assert o.cues == ["police_style_uniform"] and o.confidence == 0.5
