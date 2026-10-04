import pytest

from app.config import settings
from app.main import app
from app.repo import _memory as store
from app.routers.sessions import get_vision
from app.services import gaps, segmenter
from app.services.vision import VisionResult
from tests.helpers import DEV, client, seed_session

from pathlib import Path

FRAME = (Path(__file__).parent / "fixtures" / "frames" / "01_erp_cost_center_4711.jpg").read_bytes()


def ev(i, t, summary, kind="read", **ents):
    return {"id": i, "t_ms": t, "kind": kind, "summary": summary, "entities": ents, "salient": kind == "change"}


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    yield
    app.dependency_overrides.pop(get_vision, None)
    store.clear()


def test_segment_boundaries():
    events = [
        ev(1, 1000, "Invoice 4471 opened", invoice="4471"),
        ev(2, 2000, "Cost center changed", "change", invoice="4471", **{"from": "4711", "to": "0400"}),
        ev(3, 3000, "Invoice 4471 saved", invoice="4471"),
        ev(4, 4000, "Invoice 4472 opened", invoice="4472"),
        ev(5, 5000, "Looks at vendor list", invoice="4473"),   # entity in focus changes
        ev(6, 6000, "Opened the report screen", "navigate"),   # navigation
        ev(7, 7000, "Scrolls"),
        ev(8, 50000, "Back at the list"),                      # long idle gap
        ev(9, 52000, "Opens a file"),                          # said "next" between 8 and 9
    ]
    talk = [{"id": 1, "t_ms": 51000, "speaker": "expert", "text": "Okay then, next one."}]
    steps = segmenter.segment(events, talk, [])
    assert [s["event_ids"] for s in steps] == [[1, 2, 3], [4], [5], [6, 7], [8], [9]]
    assert [s["idx"] for s in steps] == [1, 2, 3, 4, 5, 6]
    assert [s["status"] for s in steps] == ["closed"] * 5 + ["open"]
    assert steps[0]["title"] == "Cost center changed" and steps[0]["t_start_ms"] == 1000 and steps[0]["t_end_ms"] == 3000
    assert all(s["status"] == "closed" for s in segmenter.segment(events, talk, [], closed=True))


def test_segment_links_questions_and_handles_empty():
    steps = segmenter.segment([ev(1, 1, "a"), ev(2, 2, "b")], [], [{"id": "q1", "anchor_event_id": 2}])
    assert steps[0]["question_ids"] == ["q1"]
    assert segmenter.segment([], [], []) == []


async def test_run_segmenter_is_idempotent_and_single_flight(monkeypatch):
    sid = await seed_session()
    segmenter.note_events(sid, 4)
    monkeypatch.setattr(settings, "segmenter_every_events", 4)
    assert segmenter.due(sid)
    first = await segmenter.run_segmenter(DEV, store, sid)
    again = await segmenter.run_segmenter(DEV, store, sid)
    assert len(first) == 2 and first == again
    assert len(await store.list_steps(DEV, sid)) == 2  # updated in place, not duplicated
    assert not segmenter.due(sid)  # nothing new since the run
    assert segmenter.current_step(sid)["idx"] == 2

    # a run already in progress makes the second call a no-op
    lock = segmenter._locks[sid]
    await lock.acquire()
    try:
        assert await segmenter.run_segmenter(DEV, store, sid) == []
    finally:
        lock.release()


async def test_segmenter_failure_is_swallowed():
    class Broken:
        async def list_events(self, *a, **k):
            raise RuntimeError("db")

    assert await segmenter.run_segmenter(DEV, Broken(), "s") == []


def test_due_by_count_and_time(monkeypatch):
    monkeypatch.setattr(settings, "segmenter_every_events", 10)
    monkeypatch.setattr(settings, "segmenter_every_s", 20.0)
    segmenter.note_events("s", 3)
    assert not segmenter.due("s")  # 3 events, clock just started
    segmenter._progress["s"] = (0, segmenter.time.monotonic() - 21)
    assert segmenter.due("s")  # 20 s passed with something new
    segmenter._progress["s"] = (3, segmenter.time.monotonic() - 21)
    assert not segmenter.due("s")  # 20 s passed but nothing new
    segmenter._progress["s"] = (3, segmenter.time.monotonic())
    segmenter.note_events("s", 10)
    assert segmenter.due("s")  # 10 new events


async def test_frames_trigger_segmenter_in_background(monkeypatch):
    monkeypatch.setattr(settings, "segmenter_every_events", 2)
    results = iter([
        VisionResult(screen_summary="s", events=[{"kind": "open", "summary": "Invoice 4471 opened", "entities": {"invoice": "4471"}}], model="f"),
        VisionResult(screen_summary="s", events=[{"kind": "change", "summary": "Cost center to 0400", "entities": {"invoice": "4471"}, "salient": True}], model="f"),
    ])

    async def fake(*a, **k):
        return next(results)

    app.dependency_overrides[get_vision] = lambda: fake
    async with client() as c:
        sid = (await c.post("/v1/teach/sessions", json={"title": "T"})).json()["session_id"]
        for t in (1, 2):
            r = await c.post(f"/v1/sessions/{sid}/frames", data={"t_ms": str(t)}, files={"frame": ("f.jpg", FRAME, "image/jpeg")})
        steps = (await c.get(f"/v1/sessions/{sid}/steps")).json()["steps"]
    assert len(steps) == 1 and steps[0]["status"] == "open" and steps[0]["event_ids"] == [1, 2]
    assert r.json()["step_update"] is None  # the run starts after this response


async def test_gaps_for_the_sample_session():
    sid = await seed_session(utterances=[])
    events = await store.list_events(DEV, sid)
    steps = segmenter.segment(events, [], [], closed=True)
    found = gaps.find_gaps(steps, events, [], [], [{"id": "c1", "text": "Why 0400?", "anchor_event_id": 2, "priority": 0.9}])
    kinds = {g.type for g in found}
    assert len(found) >= 3
    assert {"missing_reason", "missing_guardrail", "unasked_question", "unclear_term", "unseen_case"} <= kinds
    assert [g.priority for g in found] == sorted((g.priority for g in found), reverse=True)
    assert all(g.anchor_event_id in {1, 2, 3, 4} for g in found)


async def test_answered_questions_and_speech_close_gaps():
    sid = await seed_session()  # transcript has a reason and a stop-and-ask rule near the decision
    events = await store.list_events(DEV, sid)
    steps = segmenter.segment(events, await store.list_utterances(DEV, sid), [], closed=True)
    found = gaps.find_gaps(steps, events, await store.list_utterances(DEV, sid), [], [])
    assert "missing_reason" not in {g.type for g in found}
    assert "missing_guardrail" not in {g.type for g in found}
    # the 4711/0400 codes are never spoken, so they stay unclear
    assert {g.text for g in found if g.type == "unclear_term"} == {"What does '4711' mean here?", "What does '0400' mean here?"}

    # a planner candidate that was asked is not an unasked gap
    await store.upsert_question(DEV, sid, "c1", {"phase": "live", "type": "reason", "text": "Why 0400?", "anchor_event_id": 2, "asked_at_ms": 6000, "why_now": None})
    qs = await store.list_questions(DEV, sid)
    found = gaps.find_gaps(steps, events, [], qs, [{"id": "c1", "text": "Why 0400?", "anchor_event_id": 2, "priority": 0.9}])
    assert "unasked_question" not in {g.type for g in found}


def test_similar_catches_near_duplicates_but_not_different_questions():
    assert gaps.similar("Is there a limit where you would stop and ask someone?", "Is there a threshold at which you stop and ask someone?")
    assert gaps.similar("Why 0400?", "why 0400")
    assert not gaps.similar("Why this cost center?", "What does '4711' mean here?")


def _cand(i, t, ty, a, p):
    return {"id": i, "text": t, "type": ty, "anchor_event_id": a, "priority": p}


def test_dedupe_candidates_by_type_anchor_and_text():
    known = [_cand("k", "Is there a limit where you would stop?", "limit", 1, 0.5)]
    new = [
        _cand("a", "Is there a limit at which you would stop?", "guardrail", 2, 0.9),  # near-duplicate of known
        _cand("b", "Why 0400?", "reason", 3, 0.8),
        _cand("c", "Why did you pick 0400 here?", "reason", 3, 0.6),  # same type and anchor as b
    ]
    assert [x["id"] for x in gaps.dedupe_candidates(new, known)] == ["b"]
    gaps.reset_state()
    gaps.record_candidates("s", [known[0]])
    gaps.record_candidates("s", new)
    assert [x["id"] for x in gaps.get_candidates("s")] == ["k", "b"]
    gaps.reset_state()


def test_find_gaps_drops_near_duplicates_and_caps():
    events = [ev(i, i * 1000, f"Cost center changed {i}", "change", **{"from": "1", "to": "2"}) for i in range(1, 13)]
    steps = [{"idx": i, "title": f"Step {i}", "event_ids": [i], "t_start_ms": i * 1000, "t_end_ms": i * 1000} for i in range(1, 13)]
    cands = [
        _cand("x1", "Is there a limit where you would stop and ask someone?", "guardrail", 1, 0.9),
        _cand("x2", "Is there a threshold where you stop and ask someone?", "limit", 2, 0.9),
    ]
    found = gaps.find_gaps(steps, events, [], [], cands)
    assert len(found) <= gaps.MAX_GAPS
    assert len({(g.type, g.anchor_event_id) for g in found}) == len(found)
    limit_like = [g for g in found if "limit" in g.text.lower() or "threshold" in g.text.lower()]
    assert len(limit_like) == 1  # twelve steps plus two candidates ask the same thing: only one survives
