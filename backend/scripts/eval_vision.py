"""Does the vision model actually detect differences between frames?

Each case sends frame A (to build the state summary), then frame B with A's summary, and checks the
events reported for B against an expectation. Repeated N times because the endpoint is noisy.

Usage (from backend/):
    uv run python -m scripts.eval_vision
    uv run python -m scripts.eval_vision --model zai-org/GLM-5.3-Flash --trials 5
"""

import argparse
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path

from app.config import settings
from app.services.vision import extract_events, get_client

F = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "frames"
A_4711 = F / "01_erp_cost_center_4711.jpg"
B_0400 = F / "02_erp_cost_center_0400.jpg"
HOLO = F / "03_holocron_view.jpg"
B_0400_CURSOR = F / "04_erp_cost_center_0400_cursor_moved.jpg"


def blob(events: list[dict]) -> str:
    return json.dumps(events, ensure_ascii=False).lower()


@dataclass
class Case:
    name: str
    a: Path
    b: Path
    expect: str  # human description
    check: callable  # events -> bool


CASES = [
    Case("real change 4711 -> 0400", A_4711, B_0400, "reports cost center from 4711 to 0400",
         lambda ev: "4711" in blob(ev) and "0400" in blob(ev)),
    Case("reverse change 0400 -> 4711", B_0400, A_4711, "reports cost center from 0400 to 4711",
         lambda ev: "4711" in blob(ev) and "0400" in blob(ev)),
    Case("identical frame (no change)", B_0400, B_0400, "reports NO events", lambda ev: len(ev) == 0),
    Case("cursor moved only (no change)", B_0400, B_0400_CURSOR, "reports NO events", lambda ev: len(ev) == 0),
    Case("screen switch ERP -> Holocron", B_0400, HOLO, "reports a navigate/open event",
         lambda ev: any(e.get("kind") in ("navigate", "open", "change") for e in ev)),
]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=settings.nebius_vlm_model)
    ap.add_argument("--trials", type=int, default=3)
    args = ap.parse_args()
    if not settings.nebius_api_key:
        raise SystemExit("NEBIUS_API_KEY is empty. Fill it in the repo-root .env.")

    client = get_client()
    print(f"model: {args.model}   trials per case: {args.trials}\n")
    total = passed = 0
    for case in CASES:
        res, lats = [], []
        # state summary from frame A (computed once, like the live pipeline would have it)
        base = await extract_events(case.a.read_bytes(), "", model=args.model, client=client)
        for _ in range(args.trials):
            r = await extract_events(case.b.read_bytes(), base.screen_summary, model=args.model, client=client)
            ok = r.parse_ok and case.check(r.events)
            res.append(ok)
            lats.append(r.latency_ms / 1000)
            if not ok:
                last_bad = r
        total += len(res)
        passed += sum(res)
        mark = "PASS" if all(res) else ("PART" if any(res) else "FAIL")
        print(f"[{mark}] {case.name:34s} {sum(res)}/{len(res)}  median {sorted(lats)[len(lats)//2]:.1f}s  (expect: {case.expect})")
        if not all(res):
            e = [f"{x.get('kind')}: {x.get('summary')}" for x in last_bad.events] or ["(no events)"]
            print("       last miss ->", "; ".join(e)[:300])
    print(f"\noverall: {passed}/{total} checks passed")


if __name__ == "__main__":
    asyncio.run(main())
