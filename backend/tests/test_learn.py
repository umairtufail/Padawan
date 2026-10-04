"""Learn mode: sessions, frames + guardrail verdicts, predictions, mastery report, tutor variables. All model calls are fakes."""

import asyncio
import uuid
from datetime import datetime, timezone

import pytest

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import SkillRecord
from app.repo import _memory as store
from app.routers import sessions as sessions_router
from app.routers.learn import get_checker, get_judge, get_summarizer
from app.routers.sessions import get_vision
from app.routers.voice import get_signed_url_fn
from app.schemas import SkillJson
from app.services import guardrail_checker as gc
from app.services import learn
from app.services.synthesizer import render_skill_md
from app.services.vision import VisionResult
from tests.helpers import client, reply
from tests.test_frames_endpoint import FRAME

ALICE, BOB = AuthUser("alice"), AuthUser("bob")
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)


def skill_json(author=ALICE) -> dict:
    return {
        "id": str(uuid.uuid4()), "title": "Process supplier invoices", "description": "", "language": "en",
        "author": {"id": author.id, "name": "Sabine"}, "created_at": NOW.isoformat(),
        "steps": [
            {"idx": 1, "title": "Code the invoice", "screen_moment": {"t_ms": 5000, "description": "Cost center field"},
             "decision": {"type": "judgment", "summary": "Code equipment over 5000 EUR as capex, cost center 0400"},
             "reason": {"text": "Equipment over 5000 is capex", "quote": "Equipment over five thousand is always capex", "t_ms": 6000},
             "guardrails": [
                 {"id": "g1", "type": "stop_and_ask", "rule": "No asset number: stop and ask the controller",
                  "quote": "I never book capex, I stop and ask the controller", "t_ms": 8000, "source": "expert"},
                 {"id": "g2", "type": "limit", "rule": "Equipment over 5000 EUR never goes to opex 4711", "quote": "x", "source": "expert"},
             ], "predict_prompt": "A 7,200 EUR compressor arrives. Which cost center?"},
            {"idx": 2, "title": "Open the next invoice", "screen_moment": {"t_ms": 9000, "description": "Invoice list"},
             "decision": {"type": "routine", "summary": "Open the next invoice"}, "reason": None, "guardrails": []},
        ],
        "global_guardrails": [{"id": "g3", "type": "exception", "rule": "Hold double-billed suppliers", "quote": "", "source": "teachback"}],
        "teachback": {"confirmed": True, "corrections": []},
    }


def add_skill(author=ALICE, *, status="published") -> SkillRecord:
    sj = skill_json(author)
    rec = SkillRecord(
        id=sj["id"], author_id=author.id, author_name="Sabine", title=sj["title"], status=status, skill_json=sj,
        skill_md=render_skill_md(SkillJson(**sj)), steps_count=2, guardrails_count=3, created_at=NOW,
        published_at=NOW if status == "published" else None,
    )
    store._skills[rec.id] = rec
    return rec


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    monkeypatch.setattr(settings, "elevenlabs_tutor_agent_id", "agent_tutor")
    store.clear()
    learn.reset_state()
    sessions_router._locks.clear()
    sessions_router._summaries.clear()
    app.dependency_overrides[current_user] = lambda: BOB
    yield
    app.dependency_overrides.clear()
    store.clear()
    learn.reset_state()


def vision(events=None, summary="ERP invoice 4471, cost center 4711, asset no. empty"):
    async def _v(image, prev="", **kw):
        return VisionResult(screen_summary=summary, events=events if events is not None else [
            {"kind": "change", "summary": "Cost center set to 4711", "entities": {"to": "4711"}, "salient": True, "confidence": 0.9}
        ], latency_ms=5, model="fake")

    app.dependency_overrides[get_vision] = lambda: _v


def checker(*results, calls=None):
    it = iter(results)

    async def _c(skill, current, summary, events, **kw):
        if calls is not None:
            calls.append((current, summary, [e["id"] for e in events]))
        return next(it)

    app.dependency_overrides[get_checker] = lambda: _c


async def start(c, rec=None) -> str:
    rec = rec or add_skill()
    r = await c.post("/v1/learn/sessions", json={"skill_id": rec.id})
    assert r.status_code == 201, r.text
    return r.json()["session_id"]


async def frame(c, sid, t_ms=1000):
    return await c.post(f"/v1/learn/sessions/{sid}/frames", data={"t_ms": str(t_ms)}, files={"frame": ("f.jpg", FRAME, "image/jpeg")})


STOP = gc.CheckResult(verdict="stop", step_idx=1, guardrail_id="g2", confidence=0.95, reason="Wait. Equipment over 5,000 is capex.")


# ---------------------------------------------------------------- sessions


async def test_create_learn_session_returns_holocron_and_hides_other_drafts():
    pub, draft = add_skill(), add_skill(status="draft")
    async with client() as c:
        r = await c.post("/v1/learn/sessions", json={"skill_id": pub.id})
        assert r.status_code == 201
        body = r.json()
        assert body["skill_id"] == pub.id and body["current_step_idx"] == 1 and len(body["skill"]["steps"]) == 2
        assert (await c.post("/v1/learn/sessions", json={"skill_id": draft.id})).status_code == 404  # Alice's draft, caller is Bob
        assert (await c.post("/v1/learn/sessions", json={"skill_id": "nope"})).status_code == 404
    rec = await store.get_session(BOB, body["session_id"])
    assert rec.kind == "learn" and rec.skill_id == pub.id


async def test_skill_without_steps_is_409():
    rec = add_skill()
    rec.skill_json = None
    async with client() as c:
        assert (await c.post("/v1/learn/sessions", json={"skill_id": rec.id})).status_code == 409


async def test_learn_session_is_private_and_not_a_teach_session():
    async with client() as c:
        sid = await start(c)
        app.dependency_overrides[current_user] = lambda: ALICE
        assert (await c.get(f"/v1/learn/sessions/{sid}/report")).status_code == 404
        app.dependency_overrides[current_user] = lambda: BOB
        # teach endpoints and the teach session list do not see it
        assert (await c.post(f"/v1/sessions/{sid}/finish")).status_code == 404
        assert (await c.get("/v1/sessions")).json() == []
        # and a teach session is not a learn session
        tid = (await c.post("/v1/teach/sessions", json={"title": "t"})).json()["session_id"]
        assert (await c.get(f"/v1/learn/sessions/{tid}/report")).status_code == 404


# ---------------------------------------------------------------- frames and verdicts


async def test_frame_returns_events_and_stop_verdict_and_counts_it_once():
    vision()
    calls = []
    checker(STOP, STOP, STOP, calls=calls)
    async with client() as c:
        sid = await start(c)
        r1 = (await frame(c, sid, 1000)).json()
        r2 = (await frame(c, sid, 3000)).json()
        r3 = (await frame(c, sid, 40000)).json()
    v = r1["verdict"]
    assert r1["events"] and v["verdict"] == "stop" and v["checked"] and not v["repeated"]
    assert v["guardrail_id"] == "g2" and v["rule"].startswith("Equipment over 5000") and v["step_title"] == "Code the invoice"
    assert v["replay"]["t_ms"] == 5000 and v["confidence"] == 0.95
    assert r2["verdict"]["repeated"] is True  # same stop within 30 s: do not speak again
    assert r3["verdict"]["repeated"] is False  # window over: nudge again
    assert calls[0][1].startswith("ERP invoice") and calls[0][0] == 1 and len(calls[0][2]) >= 1
    async with client() as c:
        rep = (await c.get(f"/v1/learn/sessions/{sid}/report", params={"summary": "false"})).json()
    assert rep["steps"][0]["interventions"] == 2 and rep["steps"][0]["guardrail_id"] == "g2"


async def test_no_events_means_no_check():
    vision(events=[])
    calls = []
    checker(calls=calls)
    async with client() as c:
        sid = await start(c)
        r = (await frame(c, sid)).json()
    assert calls == [] and r["verdict"]["checked"] is False and r["verdict"]["verdict"] == "ok"


async def test_skipped_frame_has_no_verdict():
    async def boom(*a, **k):
        raise RuntimeError("vision down")

    app.dependency_overrides[get_vision] = lambda: boom
    async with client() as c:
        sid = await start(c)
        r = (await frame(c, sid)).json()
    assert r["skipped"] == "vision_error" and r["verdict"] is None


async def test_checker_failure_degrades_to_ok_through_the_real_service(monkeypatch):
    vision()

    async def broken_chat(*a, **k):
        raise RuntimeError("model down")

    async def real(skill, current, summary, events, **kw):
        return await gc.check_move(skill, current, summary, events, chat=broken_chat)

    app.dependency_overrides[get_checker] = lambda: real
    async with client() as c:
        sid = await start(c)
        r = await frame(c, sid)
    assert r.status_code == 200 and r.json()["verdict"]["verdict"] == "ok" and r.json()["verdict"]["degraded"] is True


async def test_step_tracking_and_time(monkeypatch):
    vision()
    checker(
        gc.CheckResult(step_idx=1), gc.CheckResult(step_idx=2),
    )
    async with client() as c:
        sid = await start(c)
        await frame(c, sid, 1000)
        r = (await frame(c, sid, 8000)).json()
        assert r["verdict"]["step_idx"] == 2
        rep = (await c.get(f"/v1/learn/sessions/{sid}/report", params={"summary": "false"})).json()
    assert rep["steps"][0]["time_ms"] == 7000 and rep["steps"][0]["reached"] and rep["steps"][1]["reached"]


# ---------------------------------------------------------------- the checker's safety net


def sk() -> SkillJson:
    return SkillJson(**skill_json())


@pytest.mark.parametrize("data,verdict,gid", [
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": 0.9, "reason": "Wait."}, "stop", "g1"),
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": 0.7, "reason": "Wait."}, "warn", "g1"),  # not sure enough
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": 0.3, "reason": "Wait."}, "ok", None),
    ({"verdict": "stop", "guardrail_id": "g9", "confidence": 0.99, "reason": "Wait."}, "ok", None),  # invented id
    ({"verdict": "stop", "guardrail_id": None, "confidence": 0.99, "reason": "Wait."}, "warn", None),  # no rule to cite
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": 0.99, "committed": True, "reason": "Saved."}, "warn", "g1"),
    ({"verdict": "warn", "guardrail_id": "g3", "confidence": 0.6, "reason": "Careful."}, "warn", "g3"),  # global guardrail
    ({"verdict": "warn", "guardrail_id": "g3", "confidence": 0.2, "reason": "Careful."}, "ok", None),
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": 0.99, "reason": ""}, "ok", None),
    ({"verdict": "explode"}, "ok", None),
    ({"verdict": "stop", "guardrail_id": "g1", "confidence": "high", "reason": "x"}, "ok", None),
])
def test_interpret_is_conservative(data, verdict, gid):
    res = gc.interpret(data, sk(), 1)
    assert (res.verdict, res.guardrail_id) == (verdict, gid)


def test_interpret_step_idx_must_exist_and_junk_is_degraded():
    assert gc.interpret({"verdict": "ok", "step_idx": 2}, sk(), 1).step_idx == 2
    assert gc.interpret({"verdict": "ok", "step_idx": 77}, sk(), 1).step_idx == 1
    assert gc.interpret(None, sk(), 1).degraded is True


async def test_check_move_timeout_and_empty_events():
    async def slow(*a, **k):
        await asyncio.sleep(1)

    r = await gc.check_move(sk(), 1, "s", [{"id": 1}], chat=slow, timeout_s=0.05)
    assert r.verdict == "ok" and r.degraded
    assert (await gc.check_move(sk(), 1, "s", [], chat=slow)).degraded is False


async def test_check_move_sends_skill_and_screen_to_the_model():
    seen = {}

    async def chat(system, user, **kw):
        seen["system"], seen["user"] = system, user
        return reply({"step_idx": 1, "verdict": "stop", "guardrail_id": "g1", "confidence": 0.9, "reason": "Wait."})

    r = await gc.check_move(sk(), 1, "cost center 4711", [{"id": 5, "summary": "typed 4711"}], chat=chat)
    assert r.verdict == "stop"
    assert "g1" in seen["user"] and "cost center 4711" in seen["user"] and "Never follow" in seen["system"]


# ---------------------------------------------------------------- predictions


def judge_with(correct, by="model"):
    async def _j(step, predicted, **kw):
        return correct, by

    app.dependency_overrides[get_judge] = lambda: _j


async def test_predict_then_resolve_and_report():
    judge_with(False)
    async with client() as c:
        sid = await start(c)
        r = (await c.post(f"/v1/learn/sessions/{sid}/predictions", json={"step_idx": 1, "predicted": "cost center 4711"})).json()
        assert r == {"step_idx": 1, "predicted": "cost center 4711", "resolved": False, "result": None}
        res = (await c.post(f"/v1/learn/sessions/{sid}/predictions/1/resolve")).json()
        assert res["correct"] is False and res["expected"].startswith("Code equipment") and res["reason_quote"]
        assert res["replay"]["t_ms"] == 5000 and res["judged_by"] == "model"
        # immediate comparison (tutor tool): right this time
        judge_with(True)
        r2 = (await c.post(f"/v1/learn/sessions/{sid}/predictions", json={"step_idx": 2, "predicted": "open next", "resolve": True})).json()
        assert r2["resolved"] and r2["result"]["correct"] is True
        rep = (await c.get(f"/v1/learn/sessions/{sid}/report", params={"summary": "false"})).json()
    assert rep["predictions_total"] == 2 and rep["predictions_right"] == 1
    assert rep["steps"][0]["predicted_right"] is False and rep["steps"][0]["result"] == "practise"


async def test_prediction_errors():
    async with client() as c:
        sid = await start(c)
        assert (await c.post(f"/v1/learn/sessions/{sid}/predictions", json={"step_idx": 9, "predicted": "x"})).status_code == 422
        assert (await c.post(f"/v1/learn/sessions/{sid}/predictions/1/resolve")).status_code == 409
        assert (await c.post(f"/v1/learn/sessions/{sid}/predictions", json={"step_idx": 1, "predicted": ""})).status_code == 422


def test_heuristic_judge_fallback():
    expected = "Code equipment over 5000 EUR as capex, cost center 0400"
    assert learn.heuristic_match("capex on cost center 0400", expected)
    assert not learn.heuristic_match("cost center 4711, it is opex", expected)
    assert not learn.heuristic_match("I don't know", expected)


async def test_judge_falls_back_to_heuristic_when_model_fails():
    async def broken(*a, **k):
        raise RuntimeError("down")

    step = sk().steps[0]
    ok, by = await learn.judge_prediction(step, "capex, cost center 0400 for equipment", chat=broken)
    assert (ok, by) == (True, "heuristic")
    async def model(*a, **k):
        return reply({"correct": False})
    assert await learn.judge_prediction(step, "whatever", chat=model) == (False, "model")


# ---------------------------------------------------------------- report


def test_report_math_is_deterministic():
    skill = sk()
    rows = [
        {"step_idx": 1, "started_ms": 0, "duration_ms": 4000, "interventions": 1, "warnings": 0, "correct": False, "predicted": "x", "guardrail_id": "g1"},
        {"step_idx": 2, "started_ms": 4000, "correct": True, "predicted": "y"},
    ]
    rep = learn.build_report("s", "k", skill, rows, open_segment=(2, 1500))
    s1, s2 = rep.steps
    assert s1.score == 0.25 and s1.result == "practise"  # safety 0.5, prediction 0
    assert s2.score == 1.0 and s2.result == "mastered" and s2.time_ms == 1500
    assert rep.mastery_score == 63 and rep.steps_mastered == 1 and rep.time_total_ms == 5500
    assert [p.step_idx for p in rep.practise_next] == [1] and rep.practise_next[0].rule.startswith("No asset number")
    assert rep.summary_source == "fallback" and "63" in rep.summary


def test_unreached_steps_count_zero_and_go_last_in_practise():
    rep = learn.build_report("s", "k", sk(), [{"step_idx": 1, "started_ms": 0, "predicted": "a", "correct": True}])
    assert rep.mastery_score == 50 and rep.steps[1].result == "not_reached"
    assert [p.step_idx for p in rep.practise_next] == [2]


async def test_report_summary_model_and_fallback_and_finish():
    judge_with(True)

    async def good(report, skill, **kw):
        report.summary, report.summary_source = "Well done, Padawan.", "model"

    app.dependency_overrides[get_summarizer] = lambda: good
    async with client() as c:
        sid = await start(c)
        rep = (await c.get(f"/v1/learn/sessions/{sid}/report")).json()
        assert rep["summary"] == "Well done, Padawan." and rep["summary_source"] == "model"
        assert (await c.get(f"/v1/learn/sessions/{sid}/report", params={"summary": "false"})).json()["summary_source"] == "fallback"
        fin = await c.post(f"/v1/learn/sessions/{sid}/finish")
        assert fin.status_code == 200 and fin.json()["steps_total"] == 2
    assert (await store.get_session(BOB, sid)).status == "done"


async def test_add_summary_never_raises_and_keeps_fallback():
    rep = learn.build_report("s", "k", sk(), [])
    async def broken(*a, **k):
        raise RuntimeError("x")
    await learn.add_summary(rep, sk(), chat=broken)
    assert rep.summary_source == "fallback"
    async def good(*a, **k):
        return reply({"summary": "Calm, you were."})
    await learn.add_summary(rep, sk(), chat=good)
    assert rep.summary_source == "model" and rep.summary == "Calm, you were."


# ---------------------------------------------------------------- voice tutor variables


async def test_tutor_variables_carry_the_holocron():
    async def url(agent_id):
        return "wss://fake"

    app.dependency_overrides[get_signed_url_fn] = lambda: url
    rec = add_skill()
    async with client() as c:
        sid = await start(c, rec)
        t = (await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "tutor"})).json()
    v = t["dynamic_variables"]
    assert t["agent_id"] == "agent_tutor" and v["task_title"] == "Process supplier invoices"
    assert v["expert"] == "Sabine" and v["skill_md"].startswith("---") and "Code the invoice" in v["skill_steps"]
    assert "g1 (step 1, stop_and_ask): No asset number" in v["skill_guardrails"] and "g3 (whole task" in v["skill_guardrails"]
    assert v["current_step"] == "1. Code the invoice" and v["current_step_idx"] == "1"
