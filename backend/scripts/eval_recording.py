"""Run the vision pipeline on a REAL screen recording (or a folder of frames) and write a report.

It does what the app does, offline: sample frames, keep only the ones the frontend's change detector
would send (a Python port of frontend/lib/frame-diff.ts), send each kept frame to the real vision
service threading the previous (redacted) summary like POST /sessions/{id}/frames, redact PII, and
write a markdown + JSON report to backend/eval_out/ (gitignored).

Usage (from backend/):
    uv run python -m scripts.eval_recording rec.mp4
    uv run python -m scripts.eval_recording rec.mp4 --expect expectations.json --trials 3
    uv run python -m scripts.eval_recording path/to/frames/ --gate none --interval-ms 1000

Video needs ffmpeg on PATH (`brew install ffmpeg`). Frame folders need only Pillow.
The Nebius key comes from the repo-root .env and is never printed.

expectations.json: a list of
    {"name": "cost center re-coded", "t_ms_range": [2000, 4500], "must_mention": ["4711", "0400"]}
An expectation is met when every `must_mention` string (case-insensitive) appears in the events of the
frames kept inside the range (kind, summary, entities, visible_text). Optional "max_events": N turns it
into a "nothing should be reported here" check (met when at most N events were reported).
"""

import argparse
import asyncio
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageChops

from app.config import settings
from app.services.pii import redact_frame_result

OUT_DIR = Path(__file__).resolve().parent.parent / "eval_out"
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}

# Same numbers as frontend/app/screen-capture.tsx and the defaults in frontend/lib/frame-diff.ts.
COMPARE_W, COMPARE_H, BLOCK = 640, 360, 20
PIXEL_TOL, BLOCK_FRAC, STRONG_FRAC = 25, 0.04, 0.25
MIN_CLUSTER, MIN_SCATTERED, AREA_PCT, MIN_LOCAL_PCT = 2, 3, 3.0, 0.03
SETTLE_MS, MAX_SETTLE_MS, COOLDOWN_MS = 500, 3000, 1000


# ----------------------------------------------------------------------------- change detection

@dataclass
class Diff:
    changed_pixels: int = 0
    changed_percent: float = 0.0
    changed_blocks: int = 0
    largest_cluster: int = 0
    reason: str = "none"

    @property
    def significant(self) -> bool:
        return self.reason != "none"


def luma(img: Image.Image) -> Image.Image:
    """Comparison copy: 640x360 grayscale (ITU-R 601 luma, like the frontend)."""
    return img.convert("L").resize((COMPARE_W, COMPARE_H), Image.BILINEAR)


def diff_frames(prev: Image.Image, curr: Image.Image) -> Diff:
    """Port of diffFrames() in frame-diff.ts, on two same-size 'L' images, using Pillow only."""
    w, h = curr.size
    cols, rows = -(-w // BLOCK), -(-h // BLOCK)
    mask = ImageChops.difference(prev, curr).point(lambda v: 255 if v >= PIXEL_TOL else 0)
    changed_pixels = mask.histogram()[255]
    changed_percent = changed_pixels / (w * h) * 100
    if changed_pixels == 0:
        return Diff()
    # Mean of the 0/255 mask per block = fraction of changed pixels in that block (x255).
    small = mask.resize((cols, rows), Image.BOX)
    grid = list(small.get_flattened_data() if hasattr(small, "get_flattened_data") else small.getdata())
    changed = [[False] * cols for _ in range(rows)]
    n_changed, strong = 0, False
    for i, v in enumerate(grid):
        frac = v / 255
        if v > 0 and frac >= BLOCK_FRAC:
            changed[i // cols][i % cols] = True
            n_changed += 1
            strong = strong or frac >= STRONG_FRAC
    largest, seen = 0, set()
    for r in range(rows):
        for c in range(cols):
            if not changed[r][c] or (r, c) in seen:
                continue
            stack, size = [(r, c)], 0
            seen.add((r, c))
            while stack:
                cr, cc = stack.pop()
                size += 1
                for nr in range(max(0, cr - 1), min(rows, cr + 2)):
                    for nc in range(max(0, cc - 1), min(cols, cc + 2)):
                        if changed[nr][nc] and (nr, nc) not in seen:
                            seen.add((nr, nc))
                            stack.append((nr, nc))
            largest = max(largest, size)
    reason = "none"
    if changed_percent >= AREA_PCT:
        reason = "large-area"
    elif changed_percent >= MIN_LOCAL_PCT:
        if largest >= MIN_CLUSTER:
            reason = "local-cluster"
        elif n_changed >= MIN_SCATTERED:
            reason = "scattered"
        elif strong:
            reason = "strong-block"
    return Diff(changed_pixels, round(changed_percent, 3), n_changed, largest, reason)


@dataclass
class Decision:
    action: str  # baseline-capture | idle | waiting | capture
    reason: str  # initial | change | idle | waiting
    diff: Diff | None = None


class ChangeDetector:
    """Port of the ChangeDetector class in frame-diff.ts: baseline, settle, max-settle, cooldown."""

    def __init__(self, settle_ms=SETTLE_MS, max_settle_ms=MAX_SETTLE_MS, cooldown_ms=COOLDOWN_MS):
        self.settle_ms, self.max_settle_ms, self.cooldown_ms = settle_ms, max_settle_ms, cooldown_ms
        self.baseline: Image.Image | None = None
        self.previous: Image.Image | None = None
        self.pending_since: int | None = None
        self.stable_since: int | None = None
        self.last_capture = float("-inf")

    def sample(self, curr: Image.Image, now_ms: int) -> Decision:
        if self.baseline is None or self.previous is None:
            self.baseline = self.previous = curr
            self.last_capture = now_ms
            return Decision("capture", "initial")
        diff = diff_frames(self.baseline, curr)
        motion = diff_frames(self.previous, curr)
        self.previous = curr
        if not diff.significant:
            self.pending_since = self.stable_since = None
            return Decision("idle", "idle", diff)
        if self.pending_since is None:
            self.pending_since = now_ms
        if motion.significant:
            self.stable_since = None
        elif self.stable_since is None:
            self.stable_since = now_ms
        cooled = now_ms - self.last_capture >= self.cooldown_ms
        settled = self.stable_since is not None and now_ms - self.stable_since >= self.settle_ms
        forced = now_ms - self.pending_since >= self.max_settle_ms
        if cooled and (settled or forced):
            self.baseline = curr
            self.pending_since = self.stable_since = None
            self.last_capture = now_ms
            return Decision("capture", "change", diff)
        return Decision("waiting", "waiting", diff)


# ----------------------------------------------------------------------------- sampling

@dataclass
class Sampled:
    t_ms: int
    path: Path
    kept: bool
    reason: str  # initial | change | idle | waiting | no_gate
    changed_percent: float = 0.0


def sample_frames(frames: list[tuple[int, Path]], gate: str = "frontend") -> list[Sampled]:
    """Decide for each (t_ms, path) whether the app would have sent it. gate: 'frontend' or 'none'."""
    if gate == "none":
        return [Sampled(t, p, True, "no_gate") for t, p in frames]
    det, out = ChangeDetector(), []
    for t, p in frames:
        with Image.open(p) as im:
            d = det.sample(luma(im), t)
        out.append(Sampled(t, p, d.action == "capture", d.reason, d.diff.changed_percent if d.diff else 0.0))
    return out


def list_frame_files(folder: Path, interval_ms: int) -> list[tuple[int, Path]]:
    """Frames of a folder in natural filename order, `interval_ms` apart (frame_001.jpg, frame_002.jpg, ...)."""
    def key(p: Path):
        return [int(x) if x.isdigit() else x for x in re.split(r"(\d+)", p.name)]
    files = sorted((p for p in folder.iterdir() if p.suffix.lower() in IMAGE_EXT), key=key)
    return [(i * interval_ms, p) for i, p in enumerate(files)]


def extract_video_frames(video: Path, dest: Path, fps: float, width: int = 1280) -> list[tuple[int, Path]]:
    """Sample `fps` frames per second with ffmpeg as JPEG (quality like the frontend's 0.88)."""
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found. Install it (brew install ffmpeg) or pass a folder of frames.")
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vf", f"fps={fps},scale='min({width},iw)':-2",
           "-q:v", "3", str(dest / "f_%05d.jpg")]
    subprocess.run(cmd, check=True)
    files = sorted(dest.glob("f_*.jpg"))
    return [(round(i * 1000 / fps), p) for i, p in enumerate(files)]


# ----------------------------------------------------------------------------- pipeline

VisionFn = Callable[..., Awaitable]


@dataclass
class FrameRun:
    t_ms: int
    file: str
    status: str  # ok | timeout | vision_error | parse_error
    latency_ms: int = 0
    summary: str = ""
    events: list[dict] = field(default_factory=list)
    redactions: int = 0
    prev_summary: str = ""
    raw: str = ""  # first 400 chars of the model output, kept only for parse errors


async def run_pipeline(kept: list[Sampled], extract: VisionFn, timeout_s: float, model: str | None = None) -> list[FrameRun]:
    """Kept frames in order, threading the previous redacted summary exactly like analyse_frame()."""
    runs, prev = [], ""
    for s in kept:
        kwargs = {"mime": "image/png" if s.path.suffix.lower() == ".png" else "image/jpeg"}
        if model:
            kwargs["model"] = model
        run = FrameRun(s.t_ms, s.path.name, "ok", prev_summary=prev)
        try:
            res = await asyncio.wait_for(extract(s.path.read_bytes(), prev, **kwargs), timeout=timeout_s)
        except asyncio.TimeoutError:
            run.status, run.latency_ms = "timeout", int(timeout_s * 1000)
            runs.append(run)
            continue
        except Exception as e:  # never print anything that could carry the key
            run.status = "vision_error"
            run.summary = type(e).__name__
            runs.append(run)
            continue
        run.latency_ms = res.latency_ms
        if not res.parse_ok or not res.screen_summary:
            run.status = "parse_error"  # previous summary is kept, like the endpoint
            run.raw = (res.raw or "")[:400]
            runs.append(run)
            continue
        summary, events, n = redact_frame_result(res.screen_summary, [e for e in res.events if isinstance(e, dict)])
        run.summary, run.events, run.redactions = summary, events, n
        prev = summary
        runs.append(run)
    return runs


# ----------------------------------------------------------------------------- scoring and report

def events_blob(events: list[dict]) -> str:
    return json.dumps(events, ensure_ascii=False).lower()


def score_expectations(expectations: list[dict], runs: list[FrameRun]) -> list[dict]:
    out = []
    for ex in expectations:
        lo, hi = ex["t_ms_range"]
        inside = [r for r in runs if lo <= r.t_ms <= hi]
        ok_frames = [r for r in inside if r.status == "ok"]
        events = [e for r in ok_frames for e in r.events]
        blob = events_blob(events)
        needles = [m.lower() for m in ex.get("must_mention", [])]
        missing = [m for m in needles if m not in blob]
        if "max_events" in ex:
            met = len(events) <= ex["max_events"] and not missing
        else:
            met = bool(needles) and not missing
        if not inside:
            why = "no frame kept in range (gate dropped it)"
        elif not ok_frames:
            why = "kept frame(s) failed: " + ", ".join(r.status for r in inside)
        elif met:
            why = "met"
        elif "max_events" in ex:
            why = f"{len(events)} events reported, max {ex['max_events']}"
        else:
            why = "missing: " + ", ".join(missing)
        out.append({"name": ex.get("name", f"{lo}-{hi}"), "t_ms_range": [lo, hi], "met": met,
                    "frames_in_range": len(inside), "why": why})
    return out


def counters(sampled: list[Sampled], runs: list[FrameRun]) -> dict:
    ok = [r for r in runs if r.status == "ok"]
    n_events = sum(len(r.events) for r in ok)
    salient = sum(1 for r in ok for e in r.events if e.get("salient"))
    lats = sorted(r.latency_ms for r in runs if r.latency_ms)
    skipped: dict[str, int] = {}
    for s in sampled:
        if not s.kept:
            skipped[s.reason] = skipped.get(s.reason, 0) + 1
    for r in runs:
        if r.status != "ok":
            skipped[r.status] = skipped.get(r.status, 0) + 1
    return {
        "frames_total": len(sampled), "frames_kept": sum(s.kept for s in sampled),
        "frames_analysed_ok": len(ok),
        "parse_errors": sum(r.status == "parse_error" for r in runs),
        "timeouts": sum(r.status == "timeout" for r in runs),
        "vision_errors": sum(r.status == "vision_error" for r in runs),
        "events_total": n_events, "events_per_ok_frame": round(n_events / len(ok), 2) if ok else 0.0,
        "salient_events": salient, "salient_ratio": round(salient / n_events, 2) if n_events else 0.0,
        "frames_with_no_events": sum(1 for r in ok if not r.events),
        "redactions": sum(r.redactions for r in ok),
        "latency_ms_median": lats[len(lats) // 2] if lats else 0,
        "latency_ms_p90": lats[min(len(lats) - 1, int(len(lats) * 0.9))] if lats else 0,
        "latency_ms_max": lats[-1] if lats else 0,
        "skipped": skipped,
    }


def fmt_t(t_ms: int) -> str:
    return f"{t_ms // 60000:02d}:{(t_ms % 60000) // 1000:02d}.{t_ms % 1000:03d}"


def build_report(source: str, model: str, gate: str, trials: list[dict]) -> str:
    """Markdown. `trials` items: {sampled, runs, expectations}. The timeline shows trial 1."""
    t1 = trials[0]
    c = counters(t1["sampled"], t1["runs"])
    L = [f"# Recording eval: {source}", "", f"- model: `{model}`   gate: `{gate}`   trials: {len(trials)}", "",
         "## Counters (trial 1)", "",
         f"- frames kept / total: **{c['frames_kept']} / {c['frames_total']}**",
         f"- analysed ok: {c['frames_analysed_ok']}, parse errors: {c['parse_errors']}, "
         f"timeouts: {c['timeouts']}, vision errors: {c['vision_errors']}",
         f"- events: {c['events_total']} ({c['events_per_ok_frame']} per frame), "
         f"salient ratio {c['salient_ratio']}, frames with no events: {c['frames_with_no_events']}",
         f"- latency ms: median {c['latency_ms_median']}, p90 {c['latency_ms_p90']}, max {c['latency_ms_max']}",
         f"- redactions: {c['redactions']}",
         f"- skipped: {json.dumps(c['skipped']) if c['skipped'] else 'none'}", ""]
    if len(trials) > 1:
        L += ["## Across trials", ""]
        for i, t in enumerate(trials, 1):
            ci = counters(t["sampled"], t["runs"])
            rec = ""
            if t["expectations"]:
                rec = f", recall {sum(e['met'] for e in t['expectations'])}/{len(t['expectations'])}"
            L.append(f"- trial {i}: ok {ci['frames_analysed_ok']}/{ci['frames_kept']}, events {ci['events_total']}, "
                     f"parse errors {ci['parse_errors']}, median {ci['latency_ms_median']} ms{rec}")
        L.append("")
    if t1["expectations"]:
        n = len(t1["expectations"])
        L += ["## Expectations", ""]
        L += ["| expectation | range | " + " | ".join(f"trial {i}" for i in range(1, len(trials) + 1)) + " | detail (trial 1) |",
              "|---|---|" + "---|" * len(trials) + "---|"]
        for j, e in enumerate(t1["expectations"]):
            marks = " | ".join("met" if t["expectations"][j]["met"] else "MISS" for t in trials)
            L.append(f"| {e['name']} | {fmt_t(e['t_ms_range'][0])}-{fmt_t(e['t_ms_range'][1])} | {marks} | {e['why']} |")
        rec = [sum(e["met"] for e in t["expectations"]) / n for t in trials]
        L += ["", f"Recall: **{sum(rec) / len(rec):.0%}** mean over {len(trials)} trial(s) "
                  f"({', '.join(f'{r:.0%}' for r in rec)})", ""]
    L += ["## Timeline (trial 1)", ""]
    runs_by_t = {r.t_ms: r for r in t1["runs"]}
    idle_run: list[Sampled] = []

    def flush():
        if idle_run:
            reasons = sorted({s.reason for s in idle_run})
            L.append(f"- {fmt_t(idle_run[0].t_ms)} to {fmt_t(idle_run[-1].t_ms)}: "
                     f"{len(idle_run)} frame(s) not sent ({', '.join(reasons)})")
            idle_run.clear()

    for s in t1["sampled"]:
        if not s.kept:
            idle_run.append(s)
            continue
        flush()
        r = runs_by_t.get(s.t_ms)
        head = f"### {fmt_t(s.t_ms)}  `{s.path.name}`  ({s.reason})"
        if r is None or r.status != "ok":
            L += [head, "", f"- SKIPPED: {r.status if r else 'not run'} ({r.latency_ms if r else 0} ms)"]
            if r and r.raw:
                L.append(f"- model output starts: `{r.raw[:200]!r}`")
            L.append("")
            continue
        L += [head, "", f"- latency {r.latency_ms} ms, redactions {r.redactions}", f"- summary: {r.summary}"]
        if not r.events:
            L.append("- events: none")
        for e in r.events:
            flag = " **salient**" if e.get("salient") else ""
            L.append(f"- [{e.get('kind')}]{flag} {e.get('summary')} (conf {e.get('confidence')}) "
                     f"{json.dumps(e.get('entities', {}), ensure_ascii=False)}")
        L.append("")
    flush()
    return "\n".join(L) + "\n"


def report_json(source: str, model: str, gate: str, trials: list[dict]) -> dict:
    return {"source": source, "model": model, "gate": gate, "trials": [
        {"counters": counters(t["sampled"], t["runs"]), "expectations": t["expectations"],
         "sampled": [{**asdict(s), "path": s.path.name} for s in t["sampled"]],
         "runs": [asdict(r) for r in t["runs"]]} for t in trials]}


# ----------------------------------------------------------------------------- cli

async def evaluate(frames: list[tuple[int, Path]], gate: str, trials: int, expectations: list[dict],
                   extract: VisionFn, timeout_s: float, model: str | None = None) -> list[dict]:
    sampled = sample_frames(frames, gate)
    kept = [s for s in sampled if s.kept]
    out = []
    for _ in range(trials):
        runs = await run_pipeline(kept, extract, timeout_s, model)
        out.append({"sampled": sampled, "runs": runs, "expectations": score_expectations(expectations, runs)})
    return out


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("source", type=Path, help="video file (mp4/mov/webm) or folder of frames")
    ap.add_argument("--expect", type=Path, help="expectations.json (see module docstring)")
    ap.add_argument("--trials", type=int, default=1)
    ap.add_argument("--model", default=settings.nebius_vlm_model)
    ap.add_argument("--fps", type=float, default=4.0, help="video sampling rate (the app checks a few times a second)")
    ap.add_argument("--interval-ms", type=int, default=1000, help="time between frames of a folder")
    ap.add_argument("--gate", choices=["frontend", "none"], help="default: frontend for video, none for a folder")
    ap.add_argument("--max-frames", type=int, default=0, help="stop after N sampled frames (0 = all)")
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    args = ap.parse_args()

    if not settings.nebius_api_key:
        raise SystemExit("NEBIUS_API_KEY is empty. Fill it in the repo-root .env.")
    if not args.source.exists():
        raise SystemExit(f"not found: {args.source}")
    expectations = json.loads(args.expect.read_text()) if args.expect else []

    from app.services.vision import extract_events, get_client
    client = get_client()

    async def extract(data, prev, **kw):
        return await extract_events(data, prev, client=client, **kw)

    with tempfile.TemporaryDirectory() as tmp:
        if args.source.is_dir():
            frames, gate = list_frame_files(args.source, args.interval_ms), args.gate or "none"
        elif args.source.suffix.lower() in VIDEO_EXT:
            frames, gate = extract_video_frames(args.source, Path(tmp), args.fps), args.gate or "frontend"
        else:
            raise SystemExit("source must be a folder or a .mp4/.mov/.webm file")
        if args.max_frames:
            frames = frames[: args.max_frames]
        if not frames:
            raise SystemExit("no frames found")
        print(f"{len(frames)} frames sampled, gate={gate}, model={args.model}, trials={args.trials}")
        trials = await evaluate(frames, gate, args.trials, expectations, extract, settings.vision_timeout_s, args.model)

    args.out.mkdir(parents=True, exist_ok=True)
    stem = f"{args.source.stem}_{datetime.now():%Y%m%d_%H%M%S}"
    (args.out / f"{stem}.md").write_text(build_report(args.source.name, args.model, gate, trials))
    (args.out / f"{stem}.json").write_text(json.dumps(report_json(args.source.name, args.model, gate, trials), indent=1))
    c = counters(trials[0]["sampled"], trials[0]["runs"])
    print(f"kept {c['frames_kept']}/{c['frames_total']}, ok {c['frames_analysed_ok']}, parse errors {c['parse_errors']}, "
          f"events/frame {c['events_per_ok_frame']}, salient {c['salient_ratio']}, median {c['latency_ms_median']} ms")
    if expectations:
        for i, t in enumerate(trials, 1):
            print(f"trial {i}: recall {sum(e['met'] for e in t['expectations'])}/{len(expectations)}")
    print(f"report: {args.out / (stem + '.md')}")


if __name__ == "__main__":
    asyncio.run(main())
