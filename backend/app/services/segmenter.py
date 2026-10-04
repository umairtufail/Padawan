"""Group events into steps (`steps_draft`), live while the session runs.

Deterministic rules, no model call, so it is fast and cannot break the stream. A new step starts when:
- the entity in focus changes (a different invoice, order, ticket...),
- the previous event was a save or submit,
- the screen navigates,
- there was a long idle gap before the event,
- the expert said "next", "okay then"... between the previous event and this one.

The whole session is re-segmented on every run (idempotent), the last step stays `open` until finish.
"""

import asyncio
import logging
import re
import time

from ..config import settings
from ..repo import RepoError, SessionRepo
from ..auth import AuthUser

log = logging.getLogger("padawan.segmenter")

FOCUS_KEYS = (
    "invoice", "order", "ticket", "case", "document", "record", "item", "customer", "supplier",
    "account", "file", "patient", "asset", "po", "purchase_order",
)
IDLE_GAP_MS = 30_000
SAVE_RE = re.compile(r"\b(save[ds]?|submit(?:ted|s)?|post(?:ed|s)?|booked|approve[ds]?|sent|confirm(?:ed|s)?)\b", re.I)
NEXT_RE = re.compile(r"\b(next|okay,? then|ok,? then|alright,? then|moving on|now let'?s)\b", re.I)
DECISION_KINDS = {"change", "select", "type", "dialog"}


def focus_of(event: dict) -> str | None:
    ents = event.get("entities") or {}
    for key in FOCUS_KEYS:
        if ents.get(key):
            return f"{key}:{str(ents[key]).strip().lower()}"
    return None


def is_save(event: dict) -> bool:
    return event.get("kind") in ("save", "submit") or bool(SAVE_RE.search(event.get("summary", "")))


def is_decision(event: dict) -> bool:
    ents = event.get("entities") or {}
    return event.get("kind") in DECISION_KINDS and (event.get("salient") or "from" in ents or "to" in ents)


def starts_step(prev: dict, ev: dict) -> bool:
    """Boundary rules that need only two neighbouring events (the spoken "next" rule needs the transcript)."""
    f_prev, f_new = focus_of(prev), focus_of(ev)
    return bool(
        (f_prev and f_new and f_prev != f_new)
        or is_save(prev)
        or ev.get("kind") == "navigate" and prev.get("kind") != "navigate"
        or ev["t_ms"] - prev["t_ms"] > IDLE_GAP_MS
    )


def _title(events: list[dict]) -> str:
    pick = next((e for e in events if is_decision(e)), None) or next((e for e in events if e.get("salient")), events[0])
    text = pick.get("summary", "").strip().rstrip(".")
    return (text[:117] + "...") if len(text) > 120 else text or "Step"


def segment(events: list[dict], utterances: list[dict], questions: list[dict], *, closed: bool = False) -> list[dict]:
    """Return steps_draft rows {idx, title, t_start_ms, t_end_ms, event_ids, question_ids, status, keyframe_path}."""
    events = sorted(events, key=lambda e: (e.get("t_ms", 0), e.get("id", 0)))
    if not events:
        return []
    expert = [u for u in utterances if u.get("speaker") == "expert"]

    groups: list[list[dict]] = [[events[0]]]
    for prev, ev in zip(events, events[1:]):
        said_next = any(
            prev["t_ms"] < u["t_ms"] <= ev["t_ms"] and NEXT_RE.search(u.get("text", "")) for u in expert
        )
        if starts_step(prev, ev) or said_next:
            groups.append([ev])
        else:
            groups[-1].append(ev)

    steps = []
    for i, grp in enumerate(groups):
        ids = [int(e["id"]) for e in grp if "id" in e]
        shot = (
            next((e for e in grp if e.get("keyframe_path") and is_decision(e)), None)
            or next((e for e in grp if e.get("keyframe_path") and e.get("salient")), None)
            or next((e for e in grp if e.get("keyframe_path")), None)
        )
        steps.append(
            {
                "idx": i + 1,
                "keyframe_path": shot["keyframe_path"] if shot else None,
                "title": _title(grp),
                "t_start_ms": grp[0]["t_ms"],
                "t_end_ms": grp[-1]["t_ms"],
                "event_ids": ids,
                "question_ids": [q["id"] for q in questions if q.get("anchor_event_id") in ids],
                "status": "closed" if (closed or i < len(groups) - 1) else "open",
            }
        )
    return steps


# ---------------------------------------------------------------- background runner

_locks: dict[str, asyncio.Lock] = {}
_progress: dict[str, tuple[int, float]] = {}  # session -> (events at last run, monotonic time of last run)
_latest: dict[str, dict] = {}  # session -> the current open step (for `step_update` in the frames response)


def reset_state() -> None:
    _locks.clear()
    _progress.clear()
    _counts.clear()
    _latest.clear()


def current_step(session_id: str) -> dict | None:
    return _latest.get(session_id)


_counts: dict[str, int] = {}  # session -> events stored since this process saw the session


def note_events(session_id: str, n_new: int) -> None:
    _progress.setdefault(session_id, (0, time.monotonic()))  # the 20 s clock starts with the first event
    _counts[session_id] = _counts.get(session_id, 0) + n_new


def due(session_id: str) -> bool:
    """Every `segmenter_every_events` new events, or `segmenter_every_s` seconds after the last run."""
    total = _counts.get(session_id, 0)
    last_n, last_t = _progress.get(session_id, (0, 0.0))
    return total - last_n >= settings.segmenter_every_events or (
        total > last_n and time.monotonic() - last_t >= settings.segmenter_every_s
    )


async def run_segmenter(user: AuthUser, repo: SessionRepo, session_id: str, *, closed: bool = False) -> list[dict]:
    """Re-segment and save. Single flight per session: a run in progress makes this a no-op (returns [])."""
    lock = _locks.setdefault(session_id, asyncio.Lock())
    if lock.locked():
        return []
    async with lock:
        total = _counts.get(session_id, 0)
        try:
            events = await repo.list_events(user, session_id, limit=5000)
            utterances = await repo.list_utterances(user, session_id)
            questions = await repo.list_questions(user, session_id)
            steps = segment(events, utterances, questions, closed=closed)
            if steps:
                await repo.upsert_steps(user, session_id, steps)
        except RepoError:
            log.exception("segmenter could not read or store steps")
            return []
        except Exception:
            log.exception("segmenter failed")
            return []
        _progress[session_id] = (total, time.monotonic())
        if steps:
            _latest[session_id] = steps[-1]
        return steps
