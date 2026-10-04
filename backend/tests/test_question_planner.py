import asyncio
from pathlib import Path

import pytest

from app.config import settings
from app.main import app
from app.repo import _memory as store
from app.routers.sessions import get_planner, get_vision
from app.services import question_planner as qp
from app.services.vision import VisionResult
from tests.helpers import client, reply

FRAME = (Path(__file__).parent / "fixtures" / "frames" / "01_erp_cost_center_4711.jpg").read_bytes()
EVENTS = [
    {"id": 7, "t_ms": 5000, "kind": "change", "summary": "Cost center 4711 to 0400", "entities": {}, "salient": True},
    {"id": 8, "t_ms": 6000, "kind": "read", "summary": "Asset number empty", "entities": {}, "salient": True},
]


def cand(**kw):
    base = {"type": "reason", "text": "Why did you re-code it?", "anchor_event_id": 7, "priority": 0.9}
    return {**base, **kw}


def chat_returning(data):
    async def chat(system, user, **kw):
        chat.user = user
        return reply(data)

    return chat


async def test_candidates_are_validated_and_capped():
    data = {"candidates": [
        cand(),
        cand(type="guardrail", text="Is there a limit where you stop?", anchor_event_id=8, priority=0.7),
        cand(text="Ghost event question?", anchor_event_id=999),          # anchor is not a real event
        cand(type="nonsense", text="Bad type?"),                          # unknown type
        cand(text="why did you RECODE it"),                               # not a repeat of the first one
        cand(text="Third valid one?", anchor_event_id=8, priority=0.3),
        cand(text="Fourth valid one?", anchor_event_id=8, priority=0.2),  # over the cap
        {"type": "reason"},                                               # malformed
    ]}
    out = await qp.plan_questions(EVENTS, [], [], chat=chat_returning(data))
    assert len(out) == 3
    assert [c.priority for c in out] == sorted((c.priority for c in out), reverse=True)
    assert {c.anchor_event_id for c in out} <= {7, 8}
    assert all(len(c.id) == 36 for c in out)
    assert "Ghost event question?" not in [c.text for c in out]


async def test_already_asked_is_not_repeated_and_prompt_gets_context():
    chat = chat_returning({"candidates": [cand(text="Why did you re-code it?"), cand(type="limit", text="What is the limit?")]})
    asked = [{"text": "why did you re-code it", "type": "reason"}]
    out = await qp.plan_questions(EVENTS, [{"t_ms": 1, "speaker": "expert", "text": "hello"}], asked, chat=chat)
    assert [c.text for c in out] == ["What is the limit?"]
    assert "GUARDRAIL_COUNT: 0" in chat.user and "hello" in chat.user and '"id": 7' in chat.user


@pytest.mark.parametrize("failure", ["timeout", "exception", "bad_json", "wrong_shape"])
async def test_failures_mean_empty_list(failure):
    async def chat(system, user, **kw):
        if failure == "timeout":
            await asyncio.sleep(1)
        if failure == "exception":
            raise RuntimeError("nebius down")
        return reply(None if failure == "bad_json" else {"candidates": "nope"})

    assert await qp.plan_questions(EVENTS, [], [], chat=chat, timeout_s=0.05) == []


async def test_no_events_no_model_call():
    async def chat(*a, **k):
        raise AssertionError("must not be called")

    assert await qp.plan_questions([], [], [], chat=chat) == []


# ---- through the frames endpoint


def ok(summary, events):
    return VisionResult(screen_summary=summary, events=events, latency_ms=5, model="fake")


def use_vision(results):
    it = iter(results)

    async def fake(image, prev="", **kw):
        return next(it)

    app.dependency_overrides[get_vision] = lambda: fake


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    yield
    store.clear()


async def post(c, sid, t):
    return await c.post(f"/v1/sessions/{sid}/frames", data={"t_ms": str(t)}, files={"frame": ("f.jpg", FRAME, "image/jpeg")})


async def test_planner_runs_only_on_salient_frames_and_anchors_to_real_event_ids():
    calls = []

    async def plan(events, transcript, asked):
        calls.append([e["id"] for e in events])
        return await qp.plan_questions(
            events, transcript, asked,
            chat=chat_returning({"candidates": [cand(anchor_event_id=events[-1]["id"]), cand(type="guardrail", text="Where is the limit?", anchor_event_id=events[-1]["id"])]}),
        )

    app.dependency_overrides[get_planner] = lambda: plan
    salient = {"kind": "change", "summary": "Cost center 4711 to 0400", "salient": True}
    quiet = {"kind": "read", "summary": "Looked at the list", "salient": False}
    use_vision([ok("a", []), ok("b", [quiet]), ok("c", [salient])])
    async with client() as c:
        sid = (await c.post("/v1/teach/sessions", json={"title": "T"})).json()["session_id"]
        r1, r2, r3 = await post(c, sid, 1), await post(c, sid, 2), await post(c, sid, 3)
    assert r1.json()["question_candidates"] == [] and r2.json()["question_candidates"] == []
    assert len(calls) == 1  # one planner call, for the salient frame only
    body = r3.json()
    event_id = body["events"][0]["id"]
    assert [q["type"] for q in body["question_candidates"]] == ["reason", "guardrail"]
    assert all(q["anchor_event_id"] == event_id for q in body["question_candidates"])


async def test_planner_crash_does_not_break_the_frame():
    async def plan(*a):
        raise RuntimeError("boom")

    app.dependency_overrides[get_planner] = lambda: plan
    use_vision([ok("a", [{"kind": "change", "summary": "x", "salient": True}])])
    async with client() as c:
        sid = (await c.post("/v1/teach/sessions", json={"title": "T"})).json()["session_id"]
        r = await post(c, sid, 1)
    assert r.status_code == 200 and r.json()["skipped"] is None
    assert r.json()["question_candidates"] == [] and len(r.json()["events"]) == 1
