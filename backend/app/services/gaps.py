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

MAX_GAPS = 8
SIMILAR = 0.5  # token Jaccard at or above this means "the same question"
_STOP = set(
    "a an the is are was were be do does did you your i we it its this that there here of to in on at for and or "
    "with by as if then so than what when where who how would will can could should any some".split()
)
_SYN = {
    "threshold": "limit", "limits": "limit", "cap": "limit", "maximum": "limit", "max": "limit", "boundary": "limit",
    "halt": "stop", "stopping": "stop", "escalate": "ask", "asking": "ask", "someone": "ask", "anyone": "ask",
    "exceptions": "exception", "guardrails": "guardrail", "reasons": "reason", "why": "reason",
}


def _tokens(text: str) -> set[str]:
    words = re.sub(r"[^a-z0-9 ]+", " ", text.lower()).split()
    return {_SYN.get(w, w) for w in words if w not in _STOP}


def similar(a: str, b: str) -> bool:
    """Cheap near-duplicate check: same normalized text, token-set Jaccard, or one question inside the other."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return ta == tb
    inter = len(ta & tb)
    return inter / len(ta | tb) >= SIMILAR or (min(len(ta), len(tb)) >= 3 and inter / min(len(ta), len(tb)) >= 0.8)


def dedupe_candidates(candidates: list[dict], known: list[dict]) -> list[dict]:
    """Drop candidates that repeat an earlier one (same type and anchor, or a near-identical text). Best first wins."""
    kept: list[dict] = list(known)
    out: list[dict] = []
    for c in sorted(candidates, key=lambda c: -float(c.get("priority", 0.5))):
        if any(
            (k.get("type") == c.get("type") and k.get("anchor_event_id") == c.get("anchor_event_id")) or similar(k["text"], c["text"])
            for k in kept
        ):
            continue
        kept.append(c)
        out.append(c)
    return out


# Planner candidates per session, kept in this process (not persisted: the questions table holds asked ones).
_candidates: dict[str, list[dict]] = {}


def record_candidates(session_id: str, candidates: list[dict]) -> None:
    have = _candidates.setdefault(session_id, [])
    known = {c["id"] for c in have}
    have.extend(dedupe_candidates([c for c in candidates if c["id"] not in known], have))


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
    keys: list[str] = []

    def add(kind, text, step_idx, anchor, priority, key=None):
        gaps.append(Gap(id=f"gap-{len(gaps) + 1}", type=kind, text=text, step_idx=step_idx, anchor_event_id=anchor, priority=round(priority, 2)))
        keys.append(key or text)

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
                add("missing_guardrail", f"Step '{step['title']}': is there a limit where you would stop and ask someone, or is there none?", step["idx"], anchor, 0.8, key="limit stop ask someone")
            add("unseen_case", f"Step '{step['title']}': what if the amount is higher, the supplier is unknown or an approval is missing?", step["idx"], anchor, 0.4, key="higher amount unknown supplier approval missing")

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
                add("unclear_term", f"What does '{term}' mean here?", _step_of(steps, e["id"]), e["id"], 0.6, key=term)

    # Best first; one gap per (type, anchor event) and no near-duplicate text; capped.
    ranked = sorted(zip(gaps, keys, strict=True), key=lambda gk: -gk[0].priority)
    final: list[tuple[Gap, str]] = []
    for g, k in ranked:
        # unclear_term is one gap per code, several codes can share an event
        same_anchor = g.type != "unclear_term" and any((o.type, o.anchor_event_id) == (g.type, g.anchor_event_id) for o, _ in final)
        if same_anchor or (g.type != "unclear_term" and any(similar(ok, k) for o, ok in final)):
            continue
        final.append((g, k))
        if len(final) == MAX_GAPS:
            break
    return [g for g, _ in final]
