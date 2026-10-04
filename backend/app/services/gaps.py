"""Gap finder, run on finish. What is still unclear after the session, ranked for the debrief.

Gap kinds (Notion page 08):
- missing_reason: a decision with no answer and no expert speech shortly after it.
- missing_guardrail: a judgment step with no limit, exception or "none" from the expert.
- unasked_question: a planner candidate that was never asked live (candidates are kept in this process only).
- unclear_term: a code or value on screen that the expert never mentioned.
- unseen_case: the obvious what-if for a judgment step (higher amount, unknown supplier, missing approval).
"""

import re

from ..schemas import Gap
from .segmenter import is_decision

REASON_WINDOW_MS = 25_000
GUARDRAIL_RE = re.compile(
    r"\b(never|always|limit|threshold|unless|only if|except|exception|stop|ask (?:the|my|someone)|"
    r"escalate|no guardrail|nothing special|no limit|not allowed|must not|over \d+|above \d+)\b",
    re.I,
)
NONE_RE = re.compile(r"\b(no limit|no guardrail|nothing special|no exception|none)\b", re.I)
CODE_RE = re.compile(r"\b(?:\d{4,}|[A-Z]{2,}\d*)\b")

# Planner candidates per session, kept in this process (not persisted: the questions table holds asked ones).
_candidates: dict[str, list[dict]] = {}


def record_candidates(session_id: str, candidates: list[dict]) -> None:
    known = {c["id"] for c in _candidates.setdefault(session_id, [])}
    _candidates[session_id].extend(c for c in candidates if c["id"] not in known)


def get_candidates(session_id: str) -> list[dict]:
    return list(_candidates.get(session_id, []))


def reset_state() -> None:
    _candidates.clear()


def _step_of(steps: list[dict], event_id: int) -> int | None:
    return next((s["idx"] for s in steps if event_id in s.get("event_ids", [])), None)


def find_gaps(
    steps: list[dict],
    events: list[dict],
    utterances: list[dict],
    questions: list[dict],
    candidates: list[dict] | None = None,
) -> list[Gap]:
    expert = [u for u in utterances if u.get("speaker") == "expert"]
    answered_anchor = {q["anchor_event_id"] for q in questions if q.get("answer_utterance_id")}
    asked_ids = {q["id"] for q in questions}
    by_id = {e["id"]: e for e in events}
    gaps: list[Gap] = []

    def add(kind, text, step_idx, anchor, priority):
        gaps.append(Gap(id=f"gap-{len(gaps) + 1}", type=kind, text=text, step_idx=step_idx, anchor_event_id=anchor, priority=round(priority, 2)))

    for step in steps:
        evs = [by_id[i] for i in step.get("event_ids", []) if i in by_id]
        decisions = [e for e in evs if is_decision(e)]
        t0, t1 = step.get("t_start_ms") or 0, step.get("t_end_ms") or 0
        said = [u for u in expert if t0 <= u["t_ms"] <= t1 + REASON_WINDOW_MS]

        for d in decisions:
            spoken = any(d["t_ms"] <= u["t_ms"] <= d["t_ms"] + REASON_WINDOW_MS for u in expert)
            if d["id"] not in answered_anchor and not spoken:
                add("missing_reason", f"Why this: {d['summary']}?", step["idx"], d["id"], 0.9)

        if decisions:
            lim_answered = any(
                q.get("type") in ("guardrail", "limit", "exception") and q.get("answer_utterance_id") and q.get("anchor_event_id") in step.get("event_ids", [])
                for q in questions
            )
            lim_spoken = any(GUARDRAIL_RE.search(u["text"]) or NONE_RE.search(u["text"]) for u in said)
            anchor = decisions[0]["id"]
            if not (lim_answered or lim_spoken):
                add("missing_guardrail", f"Step '{step['title']}': is there a limit where you would stop and ask someone, or is there none?", step["idx"], anchor, 0.8)
            add("unseen_case", f"Step '{step['title']}': what if the amount is higher, the supplier is unknown or an approval is missing?", step["idx"], anchor, 0.4)

    for cand in candidates or []:
        if cand["id"] not in asked_ids:
            add("unasked_question", cand["text"], _step_of(steps, cand["anchor_event_id"]), cand["anchor_event_id"], 0.5 + 0.3 * float(cand.get("priority", 0.5)))

    said_all = " ".join(u["text"] for u in expert).lower()
    seen_terms: set[str] = set()
    for e in events:
        vals = [str(v) for k, v in (e.get("entities") or {}).items() if k in ("from", "to", "code", "field")]
        for term in {m for v in vals for m in CODE_RE.findall(v)}:
            if term.lower() not in said_all and term not in seen_terms:
                seen_terms.add(term)
                add("unclear_term", f"What does '{term}' mean here?", _step_of(steps, e["id"]), e["id"], 0.6)

    return sorted(gaps, key=lambda g: -g.priority)[:12]
