"""Manual harness: run the frame fixtures through the vision model and print what comes back.

Usage (from backend/):
    uv run python -m scripts.test_vision                       # default model from .env
    uv run python -m scripts.test_vision --model zai-org/GLM-5.3-Flash --model Qwen/Qwen3.8-27B
    uv run python -m scripts.test_vision --frames tests/fixtures/frames/02_erp_cost_center_0400.jpg
    uv run python -m scripts.test_vision --show-raw

Frames are processed in filename order, each one receiving the previous frame's summary,
exactly like the live pipeline will do.
"""

import argparse
import asyncio
import json
from pathlib import Path

from app.config import settings
from app.services.vision import extract_events

FRAMES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "frames"


async def run_model(model: str, frames: list[Path], show_raw: bool) -> None:
    print(f"\n=== {model} ===")
    prev = ""
    for f in frames:
        r = await extract_events(f.read_bytes(), prev, model=model)
        tokens = r.usage.get("completion_tokens", "?")
        print(f"\n[{f.name}] {r.latency_ms} ms, {tokens} completion tokens, parse_ok={r.parse_ok}")
        print(f"  summary: {r.screen_summary}")
        for e in r.events:
            ent = json.dumps(e.get("entities", {}), ensure_ascii=False)
            print(f"  - {e.get('kind')}{' *' if e.get('salient') else ''}: {e.get('summary')}  {ent}")
        if not r.events:
            print("  (no events)")
        if show_raw or not r.parse_ok:
            print("  raw:", r.raw[:800])
        prev = r.screen_summary


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", help="repeatable; defaults to NEBIUS_VLM_MODEL")
    ap.add_argument("--frames", nargs="*", help="image files; default: all fixtures")
    ap.add_argument("--show-raw", action="store_true")
    args = ap.parse_args()

    if not settings.nebius_api_key:
        raise SystemExit("NEBIUS_API_KEY is empty. Fill it in the repo-root .env.")
    frames = [Path(p) for p in args.frames] if args.frames else sorted(FRAMES_DIR.glob("*.jpg"))
    for model in args.model or [settings.nebius_vlm_model]:
        await run_model(model, frames, args.show_raw)


if __name__ == "__main__":
    asyncio.run(main())
