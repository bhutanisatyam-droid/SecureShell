"""Text-level evaluation: transcript lines -> detector -> real fusion engine, replayed line by
line as on a live call. Isolates detection quality from ASR errors.

    backend\\.venv\\Scripts\\python eval\\run_text_eval.py                 # LLM detector
    backend\\.venv\\Scripts\\python eval\\run_text_eval.py --mode rules    # keyword baseline
    backend\\.venv\\Scripts\\python eval\\run_text_eval.py --set eval\\heldout_conversations.yaml

A conversation is predicted "fraud" if its risk ever reaches --threshold (default: high).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from dotenv import load_dotenv  # noqa: E402

from callshield.adapter import _AWARENESS, _MOCK_RULES  # noqa: E402
from callshield.ai.detector import Analysis, Line, LLMDetector, Prior, backends_from_env  # noqa: E402
from callshield.contracts import LEVEL_ORDER, Evidence  # noqa: E402
from callshield.fusion import RiskEngine, load_risk_config  # noqa: E402

ROLE = {"R": "remote", "L": "local", "U": "unknown"}
LINE_GAP_MS = 5000


def rules_detect(line: Line):
    if line.role == "local" or _AWARENESS.search(line.text):
        return []
    return [(c, line.text, 0.8) for c, rx in _MOCK_RULES if rx.search(line.text)]


async def run_conversation(conv, cfg, detector, mode, sem):
    engine = RiskEngine(cfg)
    lines: list[Line] = []
    trace, latencies, prior, errors = [], [], [], []
    evidence_by_line: dict[str, list[str]] = {}
    peak = "normal"
    first_alert = {}
    t0 = 1_000_000
    for i, (role, text) in enumerate(conv["lines"]):
        t = t0 + i * LINE_GAP_MS
        line = Line(f"L{i}", ROLE[role], "speech", text, t, t)
        lines.append(line)
        found, retracted = [], []
        if line.role != "local":
            if mode == "llm":
                analysis = Analysis()
                window = lines[-16:]
                in_window = {l.line_id for l in window}
                async with sem:
                    for attempt in range(4):
                        s = time.monotonic()
                        try:
                            analysis = await detector.analyze(
                                window, [line], [p for p in prior if p.line_id in in_window][-15:])
                            latencies.append((time.monotonic() - s) * 1000)
                            break
                        except Exception as e:  # noqa: BLE001 - network blips; counted below
                            print(f"  retry {conv['id']} line {i}: {e!r}"[:160])
                            await asyncio.sleep(2 * (attempt + 1))
                    else:
                        errors.append(i)
                found = [(f.category, f.quote, f.confidence) for f in analysis.findings]
                for lid in analysis.retract:
                    engine.retract(evidence_by_line.pop(lid, []))
                    prior = [p for p in prior if p.line_id != lid]
                    retracted.append(lid)
            else:
                found = rules_detect(line)
        for j, (cat, quote, q) in enumerate(found):
            eid = f"{conv['id']}-{i}-{j}"
            engine.add(Evidence(evidence_id=eid, category=cat, source_modality="speech",
                                t_start_ms=t, t_end_ms=t, source_event_ids=[line.line_id],
                                quoted_text_or_observation=quote, quality=q), line.role)
            prior.append(Prior(line.line_id, cat, quote))
            evidence_by_line.setdefault(line.line_id, []).append(eid)
        r = engine.assess(t)
        if LEVEL_ORDER[r.risk_level] > LEVEL_ORDER[peak]:
            peak = r.risk_level
        for lvl in ("high", "critical"):
            if lvl not in first_alert and LEVEL_ORDER[r.risk_level] >= LEVEL_ORDER[lvl]:
                first_alert[lvl] = i
        trace.append({"line": i, "role": role, "text": text, "found": [c for c, _, _ in found],
                      "retracted": retracted, "risk": r.risk_index, "level": r.risk_level})
    return {"id": conv["id"], "label": conv["label"], "peak": peak, "final": r.risk_level, "first_alert": first_alert,
            "n_lines": len(conv["lines"]), "trace": trace, "llm_latency_ms": latencies, "llm_errors": errors}


def pct(xs, p):
    if not xs:
        return None
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))])


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=str(ROOT / "eval" / "dev_conversations.yaml"))
    ap.add_argument("--mode", choices=["llm", "rules"], default="llm")
    ap.add_argument("--threshold", choices=["caution", "high", "critical"], default="high")
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--only", nargs="*", help="conversation ids to run")
    ap.add_argument("--fragment", action="store_true", help="split lines like streaming ASR")
    ap.add_argument("--effort", choices=["low", "medium", "high"], default=None)
    a = ap.parse_args()

    load_dotenv(ROOT / "backend" / ".env")
    cfg = load_risk_config()
    detector = None
    if a.mode == "llm":
        text_cats = {k for k, v in cfg.categories.items() if v.modality == "text"}
        detector = LLMDetector(backends_from_env(), allowed_categories=text_cats, wait_on_rate_limit=True)
    convs = yaml.safe_load(open(a.set, encoding="utf-8"))["conversations"]
    if a.only:
        convs = [c for c in convs if c["id"] in a.only]
    if a.fragment:
        # Mimic streaming ASR, which cuts turns into fragments at pauses/clause boundaries.
        for c in convs:
            c["lines"] = [[role, frag.strip()] for role, text in c["lines"]
                          for frag in re.split(r"(?<=[,।.?!])\s+", text) if frag.strip()]
    if detector and a.effort:
        detector.reasoning_effort = a.effort
    sem = asyncio.Semaphore(a.concurrency)
    results = await asyncio.gather(*(run_conversation(c, cfg, detector, a.mode, sem) for c in convs))
    if detector:
        await detector.aclose()

    thr = LEVEL_ORDER[a.threshold]
    tp = fp = tn = fn = 0
    print(f"\n{'id':32} {'label':7} {'peak':9} {'final':9} pred   alert@line")
    for r in results:
        # Strict: any warning shown at >= threshold counts, even if later retracted.
        pred = LEVEL_ORDER[r["peak"]] >= thr
        fraud = r["label"] == "scam"
        tp += pred and fraud; fp += pred and not fraud; tn += (not pred) and not fraud; fn += (not pred) and fraud
        mark = "" if pred == fraud else "   <-- WRONG"
        at = r["first_alert"].get(a.threshold)
        alert = "" if at is None else f"{at + 1}/{r['n_lines']}"
        print(f"{r['id']:32} {r['label']:7} {r['peak']:9} {r['final']:9} {'FRAUD' if pred else 'ok   '}  {alert}{mark}")
        if a.verbose or pred != fraud:
            for t in r["trace"]:
                rt = f"  RETRACT {','.join(t['retracted'])}" if t.get("retracted") else ""
                print(f"     {t['role']} {t['level']:8} {t['risk']:3d} {','.join(t['found']) or '-':40} {t['text'][:90]}{rt}")

    n = tp + fp + tn + fn
    lat = [x for r in results for x in r["llm_latency_ms"]]
    metrics = {
        "set": Path(a.set).name, "mode": a.mode, "fragmented": a.fragment, "threshold": a.threshold, "n": n,
        "scam": tp + fn, "benign": tn + fp, "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "accuracy": round((tp + tn) / n, 3),
        "precision": round(tp / (tp + fp), 3) if tp + fp else None,
        "recall": round(tp / (tp + fn), 3) if tp + fn else None,
        "false_positive_rate": round(fp / (fp + tn), 3) if fp + tn else None,
        "false_negative_rate": round(fn / (fn + tp), 3) if fn + tp else None,
        "benign_ever_critical": sum(r["label"] == "benign" and r["peak"] == "critical" for r in results),
        "benign_flagged_at_end": sum(r["label"] == "benign" and LEVEL_ORDER[r["final"]] >= thr for r in results),
        "llm_calls": len(lat), "llm_failed_lines": sum(len(r["llm_errors"]) for r in results), "llm_latency_p50_ms": pct(lat, 50), "llm_latency_p95_ms": pct(lat, 95),
        "llm_dropped": detector.stats.dropped if detector else None,
        "llm_tokens": detector.stats.tokens if detector else None,
        "llm_skipped_by_prefilter": detector.stats.skipped_by_prefilter if detector else None,
        "config_version": cfg.version,
    }
    print("\n" + json.dumps(metrics, indent=2, ensure_ascii=False))
    out = ROOT / "eval" / "results"
    out.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (out / f"{Path(a.set).stem}-{a.mode}-{stamp}.json").write_text(
        json.dumps({"metrics": metrics, "results": results}, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
