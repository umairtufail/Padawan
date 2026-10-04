import uuid

import pytest

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import _memory as store
from tests.helpers import DEV, client, seed_session


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    yield
    app.dependency_overrides.pop(current_user, None)
    store.clear()


def asked(text="Why did you re-code it?", **kw):
    return {"type": "reason", "text": text, "anchor_event_id": 2, "asked_at_ms": 5500, "why_now": {"pause_ms": 1800}, **kw}


async def test_utterances_are_stored_in_order():
    sid = await seed_session(utterances=[])
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/utterances", json={"utterances": [
            {"t_ms": 2000, "speaker": "expert", "text": "second"}, {"t_ms": 1000, "text": "first"},
        ]})
    assert r.status_code == 200 and r.json()["stored"] == 2
    assert [u["text"] for u in await store.list_utterances(DEV, sid)] == ["first", "second"]


async def test_utterance_validation_and_unknown_session():
    sid = await seed_session(utterances=[])
    async with client() as c:
        assert (await c.post(f"/v1/sessions/{sid}/utterances", json={"utterances": []})).status_code == 422
        bad = {"utterances": [{"t_ms": 1, "speaker": "robot", "text": "x"}]}
        assert (await c.post(f"/v1/sessions/{sid}/utterances", json=bad)).status_code == 422
        ok = {"utterances": [{"t_ms": 1, "text": "x"}]}
        assert (await c.post("/v1/sessions/nope/utterances", json=ok)).status_code == 404


async def test_question_asked_then_answered():
    sid, qid = await seed_session(), str(uuid.uuid4())
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/questions/{qid}/asked", json=asked())
        assert r.status_code == 200 and r.json()["id"] == qid and r.json()["answered"] is False
        # asking again with the same id updates, it does not duplicate
        await c.post(f"/v1/sessions/{sid}/questions/{qid}/asked", json=asked(text="Why 0400?"))
        r = await c.post(f"/v1/sessions/{sid}/answers", json={"question_id": qid, "quote": "Because it is capex", "t_ms": 7000})
        assert r.status_code == 200
    qs = await store.list_questions(DEV, sid)
    assert len(qs) == 1 and qs[0]["text"] == "Why 0400?" and qs[0]["why_now"] == {"pause_ms": 1800}
    uid = r.json()["utterance_id"]
    assert qs[0]["answer_utterance_id"] == uid
    assert [u for u in await store.list_utterances(DEV, sid) if u["id"] == uid][0]["speaker"] == "expert"


async def test_answer_for_unknown_question_and_bad_question_id():
    sid = await seed_session()
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/answers", json={"question_id": str(uuid.uuid4()), "quote": "x"})
        assert r.status_code == 404
        assert (await c.post(f"/v1/sessions/{sid}/questions/not-a-uuid/asked", json=asked())).status_code == 422


async def test_finish_closes_steps_and_returns_gaps():
    sid = await seed_session(utterances=[])
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/finish")
        steps = (await c.get(f"/v1/sessions/{sid}/steps")).json()["steps"]
    body = r.json()
    assert r.status_code == 200 and body["status"] == "debrief"
    assert [s["status"] for s in body["steps"]] == ["closed", "closed"]
    assert len(body["gaps"]) >= 3 and body["gaps"][0]["priority"] >= body["gaps"][-1]["priority"]
    assert steps == body["steps"]
    assert (await store.get_session(DEV, sid)).status == "debrief"


async def test_other_users_session_is_hidden_on_every_new_route():
    sid = await seed_session()
    app.dependency_overrides[current_user] = lambda: AuthUser("mallory")
    qid = str(uuid.uuid4())
    async with client() as c:
        for method, path, body in [
            ("post", f"/v1/sessions/{sid}/utterances", {"utterances": [{"t_ms": 1, "text": "x"}]}),
            ("post", f"/v1/sessions/{sid}/questions/{qid}/asked", asked()),
            ("post", f"/v1/sessions/{sid}/answers", {"question_id": qid, "quote": "x"}),
            ("get", f"/v1/sessions/{sid}/steps", None),
            ("post", f"/v1/sessions/{sid}/finish", None),
            ("post", f"/v1/sessions/{sid}/teachback", {"confirmed": True}),
        ]:
            r = await (c.post(path, json=body) if method == "post" and body is not None else getattr(c, method)(path))
            assert r.status_code == 404, path
