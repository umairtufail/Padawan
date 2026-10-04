"""Does the question planner ask sensible questions? Calls the real model (Nebius), so it needs a key.

Scenario: the sample frames (cost center 4711 -> 0400, asset number empty), two questions already asked,
no guardrail question yet. Checks per trial: at most 3 candidates, every anchor is a real event id,
no question just reads what the screen shows, and a guardrail question is present.

Usage (from backend/):
    uv run python -m scripts.eval_question_planner --trials 5
"""

import argparse
import asyncio
import re

from app.config import settings
from app.services.question_planner import plan_questions

EVENTS = [
    {"id": 41, "t_ms": 12000, "kind": "open", "summary": "Invoice 4471 opened in SandboxERP, cost center 4711, asset no. empty",
     "entities": {"invoice": "4471", "supplier": "Kaltetechnik GmbH", "amount": "7200 EUR"}, "salient": False},
    {"id": 42, "t_ms": 19000, "kind": "change", "summary": "Cost center changed from 4711 to 0400 on invoice 4471",
     "entities": {"invoice": "4471", "field": "cost center", "from": "4711", "to": "0400"}, "salient": True},
    {"id": 43, "t_ms": 22000, "kind": "read", "summary": "Asset number field is empty and highlighted as required",
     "entities": {"invoice": "4471", "field": "asset number"}, "salient": True},
]
TRANSCRIPT = [{"t_ms": 18000, "speaker": "expert", "text": "Okay, this one is a compressor, so I need to move it."}]
ASKED = [
    {"type": "reason", "text": "Why did you open this invoice first?"},
    {"type": "reason", "text": "What made you pick this supplier?"},
]
READS_SCREEN = re.compile(r"\b(what is|what's|which|read)\b.*\b(cost center|invoice number|amount|asset number)\b", re.I)


def check(cands) -> list[str]:
    problems = []
    if not cands:
        return ["no candidates"]
    if len(cands) > 3:
        problems.append("more than 3")
    if any(c.anchor_event_id not in {41, 42, 43} for c in cands):
        problems.append("anchor not a real event")
    if any(READS_SCREEN.search(c.text) for c in cands):
        problems.append("asks what the screen shows")
    if not any(c.type in ("guardrail", "limit") for c in cands):
        problems.append("no guardrail question")
    return problems


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=3)
    args = ap.parse_args()
    if not settings.nebius_api_key:
        raise SystemExit("NEBIUS_API_KEY is empty. Fill it in the repo-root .env.")
    ok = 0
    for i in range(args.trials):
        cands = await plan_questions(EVENTS, TRANSCRIPT, ASKED, timeout_s=30)
        problems = check(cands)
        ok += not problems
        print(f"[{'PASS' if not problems else 'FAIL'}] trial {i + 1}: {problems or 'ok'}")
        for c in cands:
            print(f"        {c.type:9s} {c.priority:.2f} -> event {c.anchor_event_id}: {c.text}")
    print(f"\n{ok}/{args.trials} trials passed")


if __name__ == "__main__":
    asyncio.run(main())
