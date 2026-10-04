"""Offline tests for scripts/eval_recording.py (sampler, pipeline threading, scoring, report). No network."""

import asyncio
from pathlib import Path

from PIL import Image, ImageDraw

from app.services.vision import VisionResult
from scripts import eval_recording as er

SYNTH = Path(__file__).parent / "fixtures" / "recording_synth"


def frame(path: Path, box: tuple[int, int, int, int] | None = None) -> Path:
    im = Image.new("RGB", (640, 360), "white")
    if box:
        ImageDraw.Draw(im).rectangle(box, fill="black")
    im.save(path)
    return path


def grey(path: Path):
    with Image.open(path) as im:
        return er.luma(im)


# ---- sampler / change detector

def test_identical_frames_are_not_significant(tmp_path):
    g = grey(frame(tmp_path / "a.png"))
    assert er.diff_frames(g, g).reason == "none"


def test_large_area_and_small_local_edit_are_detected(tmp_path):
    a = grey(frame(tmp_path / "a.png"))
    assert er.diff_frames(a, grey(frame(tmp_path / "b.png", box=(0, 0, 640, 100)))).reason == "large-area"
    d = er.diff_frames(a, grey(frame(tmp_path / "c.png", box=(100, 100, 160, 120))))
    assert d.significant and d.reason in {"local-cluster", "scattered", "strong-block"}


def test_tiny_noise_is_ignored(tmp_path):
    a = grey(frame(tmp_path / "a.png"))
    assert er.diff_frames(a, grey(frame(tmp_path / "b.png", box=(10, 10, 12, 12)))).reason == "none"


def test_gate_keeps_initial_and_settled_change_only(tmp_path):
    blank = frame(tmp_path / "f0.png")
    changed = frame(tmp_path / "chg.png", box=(0, 0, 640, 200))
    frames = [(0, blank), (250, blank)] + [(t, changed) for t in range(1000, 2501, 250)]
    sampled = er.sample_frames(frames, "frontend")
    kept = [s for s in sampled if s.kept]
    assert [s.reason for s in kept] == ["initial", "change"]
    assert kept[1].t_ms == 1750  # change seen at 1000, stable from 1250, settled (500 ms) at 1750
    assert sampled[1].reason == "idle"


def test_gate_none_keeps_everything(tmp_path):
    p = frame(tmp_path / "a.png")
    assert all(s.kept for s in er.sample_frames([(0, p), (1000, p)], "none"))


def test_synth_fixture_files_and_cursor_only_frame_is_gated_out():
    frames = er.list_frame_files(SYNTH, 1000)
    assert len(frames) == 10 and frames[3][0] == 3000 and frames[0][1].name == "frame_01.jpg"
    assert [s.kept for s in er.sample_frames(frames[:2], "frontend")] == [True, False]


def test_list_frame_files_natural_order(tmp_path):
    for n in (10, 2, 1):
        frame(tmp_path / f"frame_{n}.png")
    assert [p.name for _, p in er.list_frame_files(tmp_path, 500)] == ["frame_1.png", "frame_2.png", "frame_10.png"]


# ---- pipeline with a fake model

class FakeVision:
    def __init__(self, results):
        self.results, self.calls = list(results), []

    async def __call__(self, data, prev, **kw):
        self.calls.append(prev)
        r = self.results.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def vr(summary, events=(), ok=True, ms=100):
    return VisionResult(screen_summary=summary, events=list(events), latency_ms=ms, parse_ok=ok, raw="not json")


def kept_for(tmp_path, n):
    p = frame(tmp_path / "x.png")
    return [er.Sampled(i * 1000, p, True, "no_gate") for i in range(n)]


async def test_pipeline_threads_redacted_summary_and_keeps_it_on_failure(tmp_path):
    fake = FakeVision([
        vr("form open, contact mail hans@example.com, cost center 4711"),
        vr("", ok=False),
        RuntimeError("boom"),
        vr("cost center 0400", [{"kind": "change", "summary": "4711 to 0400", "salient": True}]),
    ])
    runs = await er.run_pipeline(kept_for(tmp_path, 4), fake, timeout_s=5)
    assert fake.calls[0] == ""
    assert "hans@example.com" not in runs[0].summary and "[EMAIL]" in runs[0].summary and runs[0].redactions == 1
    # parse error and vision error do not replace the previous (redacted) summary
    assert fake.calls[1] == fake.calls[2] == fake.calls[3] == runs[0].summary
    assert [r.status for r in runs] == ["ok", "parse_error", "vision_error", "ok"]
    assert runs[1].raw == "not json"


async def test_pipeline_timeout(tmp_path):
    async def slow(data, prev, **kw):
        await asyncio.sleep(1)

    runs = await er.run_pipeline(kept_for(tmp_path, 1), slow, timeout_s=0.01)
    assert runs[0].status == "timeout"


# ---- scoring and report

def run(t, events, status="ok", ms=100):
    return er.FrameRun(t, f"f{t}.png", status, ms, "sum", events)


def test_score_expectations():
    runs = [
        run(1000, [{"kind": "change", "summary": "Cost center 4711 -> 0400", "entities": {"to": "0400"}}]),
        run(2000, [{"kind": "read", "summary": "something"}]),
        run(4000, [], status="parse_error"),
    ]
    ex = [
        {"name": "cc", "t_ms_range": [500, 1500], "must_mention": ["4711", "0400"]},
        {"name": "case", "t_ms_range": [500, 1500], "must_mention": ["COST CENTER"]},
        {"name": "quiet", "t_ms_range": [2000, 2000], "must_mention": [], "max_events": 0},
        {"name": "gone", "t_ms_range": [3000, 3500], "must_mention": ["x"]},
        {"name": "failed", "t_ms_range": [4000, 4000], "must_mention": ["x"]},
        {"name": "hold", "t_ms_range": [500, 2500], "must_mention": ["hold"]},
    ]
    res = {r["name"]: r for r in er.score_expectations(ex, runs)}
    assert res["cc"]["met"] and res["case"]["met"]
    assert not res["quiet"]["met"] and "max 0" in res["quiet"]["why"]
    assert "gate dropped" in res["gone"]["why"]
    assert "parse_error" in res["failed"]["why"]
    assert res["hold"]["why"] == "missing: hold"


def test_counters_and_report():
    p = Path("a.png")
    sampled = [er.Sampled(0, p, True, "initial"), er.Sampled(250, p, False, "idle"),
               er.Sampled(500, p, False, "waiting"), er.Sampled(1000, p, True, "change"),
               er.Sampled(2000, p, True, "change")]
    runs = [
        run(0, [{"kind": "open", "summary": "opened", "salient": False}], ms=200),
        run(1000, [{"kind": "change", "summary": "changed", "salient": True}, {"kind": "hold", "summary": "h"}], ms=400),
        er.FrameRun(2000, "f.png", "parse_error", 300, raw="oops"),
    ]
    c = er.counters(sampled, runs)
    assert (c["frames_total"], c["frames_kept"], c["frames_analysed_ok"], c["parse_errors"]) == (5, 3, 2, 1)
    assert c["events_total"] == 3 and c["events_per_ok_frame"] == 1.5 and c["salient_ratio"] == 0.33
    assert c["skipped"] == {"idle": 1, "waiting": 1, "parse_error": 1}
    exp = er.score_expectations([{"name": "ch", "t_ms_range": [900, 1100], "must_mention": ["changed"]}], runs)
    trial = {"sampled": sampled, "runs": runs, "expectations": exp}
    md = er.build_report("rec.mp4", "m", "frontend", [trial, trial])
    assert "kept / total: **3 / 5**" in md
    assert "2 frame(s) not sent (idle, waiting)" in md
    assert "Recall: **100%**" in md and "SKIPPED: parse_error" in md and "oops" in md
    assert "trial 2" in md
    data = er.report_json("rec.mp4", "m", "frontend", [trial])
    assert data["trials"][0]["counters"]["frames_kept"] == 3


async def test_evaluate_runs_trials_with_fake(tmp_path):
    p = frame(tmp_path / "a.png")
    fake = FakeVision([vr("s1", [{"kind": "change", "summary": "x 0400"}]) for _ in range(4)])
    trials = await er.evaluate([(0, p), (1000, p)], "none", 2,
                               [{"t_ms_range": [0, 1000], "must_mention": ["0400"]}], fake, 5)
    assert len(trials) == 2 and all(t["expectations"][0]["met"] for t in trials)
    assert fake.calls[2] == ""  # each trial starts from an empty summary
