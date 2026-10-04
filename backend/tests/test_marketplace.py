"""Jedi Archives marketplace: learner counts, sort, learn history, unpublish, privacy. Memory repo and a fake Supabase."""

import json

import httpx

from app.auth import AuthUser, current_user
from app.main import app
from app.repo import _memory as store
from app.routers.learn import get_summarizer
from tests.helpers import client
from tests.test_learn import ALICE, BOB, _env, add_skill, start  # noqa: F401  (the autouse fixture is reused)
from tests.test_supabase_pipeline_repo import SKID
from tests.test_supabase_repo import SID, USER, repo_with

CAROL = AuthUser("carol")


def as_user(u):
    app.dependency_overrides[current_user] = lambda: u


async def no_summary(*a, **k):
    return None


async def learn_and_finish(c, rec):
    app.dependency_overrides[get_summarizer] = lambda: no_summary
    sid = await start(c, rec)
    assert (await c.post(f"/v1/learn/sessions/{sid}/finish")).status_code == 200
    return sid


async def test_counts_history_and_privacy():
    rec = add_skill()
    other = add_skill()
    async with client() as c:
        sid = await learn_and_finish(c, rec)  # bob, mastery 0 (no steps reached)
        await start(c, rec)  # bob again: still one learner
        as_user(CAROL)
        await start(c, rec)
        as_user(ALICE)
        listing = await c.get("/v1/skills")
        rows = {s["id"]: s for s in listing.json()}
        assert rows[rec.id]["learners_count"] == 2 and rows[rec.id]["avg_mastery"] == 0.0
        assert rows[other.id]["learners_count"] == 0 and rows[other.id]["avg_mastery"] is None
        assert (await c.get(f"/v1/skills/{rec.id}")).json()["learners_count"] == 2
        assert "carol" not in listing.text and "bob" not in listing.text  # no learner identity anywhere
        assert (await c.get("/v1/learn/sessions")).json() == []  # the author has no sessions of her own
        as_user(BOB)
        hist = (await c.get("/v1/learn/sessions")).json()
        assert len(hist) == 2 and hist[0]["created_at"] >= hist[1]["created_at"]
        done = next(h for h in hist if h["session_id"] == sid)
        assert done["finished"] is True and done["mastery_score"] == 0 and done["steps_total"] == 2
        assert done["skill_id"] == rec.id and done["skill_title"] == rec.title
        assert [h["finished"] for h in hist].count(False) == 1
        as_user(CAROL)
        assert len((await c.get("/v1/learn/sessions")).json()) == 1


async def test_sort_popular_and_mastery():
    a, b, d = add_skill(), add_skill(), add_skill()
    a.title, b.title, d.title = "A", "B", "D"
    async with client() as c:
        as_user(BOB)
        await start(c, b)
        as_user(CAROL)
        await start(c, b)
        await start(c, d)
        as_user(ALICE)
        pop = [s["title"] for s in (await c.get("/v1/skills?sort=popular")).json()]
        assert pop == ["B", "D", "A"]
        assert (await c.get("/v1/skills?sort=bogus")).status_code == 422
        for s in store._sessions.values():
            if s.skill_id == d.id:
                s.status, s.mastery_score = "done", 80
            elif s.skill_id == b.id:
                s.status, s.mastery_score = "done", 40
        m = [(s["title"], s["avg_mastery"]) for s in (await c.get("/v1/skills?sort=mastery")).json()]
    assert m == [("D", 80.0), ("B", 40.0), ("A", None)]


async def test_unpublish_author_only_and_sessions_keep_working():
    rec = add_skill()
    async with client() as c:
        sid = await learn_and_finish(c, rec)  # bob
        assert (await c.post(f"/v1/skills/{rec.id}/unpublish")).status_code == 403  # visible, not his
        as_user(ALICE)
        r = await c.post(f"/v1/skills/{rec.id}/unpublish")
        assert r.status_code == 200 and r.json()["status"] == "draft" and r.json()["published_at"] is None
        assert (await c.post(f"/v1/skills/{rec.id}/unpublish")).status_code == 200  # idempotent
        as_user(CAROL)
        assert (await c.post(f"/v1/skills/{rec.id}/unpublish")).status_code == 404  # not visible
        assert (await c.post("/v1/learn/sessions", json={"skill_id": rec.id})).status_code == 404
        assert rec.id not in {s["id"] for s in (await c.get("/v1/skills")).json()}
        as_user(BOB)  # his session survives, but he cannot start a new one on the draft
        assert (await c.post("/v1/learn/sessions", json={"skill_id": rec.id})).status_code == 404
        assert (await c.get(f"/v1/learn/sessions/{sid}/report?summary=false")).status_code == 200
        assert len((await c.get("/v1/learn/sessions")).json()) == 1


async def test_supabase_skill_stats_and_learn_sessions():
    def h(req):
        if req.url.path == "/rest/v1/rpc/skill_stats":
            assert json.loads(req.content) == {"skill_ids": [SKID]}
            return httpx.Response(200, json=[{"skill_id": SKID, "learners_count": 3, "avg_mastery": "72.5"}])
        assert req.url.path == "/rest/v1/sessions" and "kind=eq.learn" in str(req.url) and f"user_id=eq.{USER.id}" in str(req.url)
        return httpx.Response(200, json=[{
            "id": SID, "user_id": USER.id, "title": "t", "started_at": "2026-10-04T10:00:00+00:00", "skill_id": SKID,
            "status": "done", "mastery_score": 80, "skills": {"title": "Invoices", "steps_count": 4},
            "learn_attempts": [{"count": 3}],
        }])

    repo, _ = repo_with(h)
    assert await repo.skill_stats(USER, [SKID, "not-a-uuid"]) == {SKID: (3, 72.5)}
    (s,) = await repo.list_learn_sessions(USER)
    assert (s.skill_title, s.steps_total, s.steps_done, s.mastery_score, s.status) == ("Invoices", 4, 3, 80, "done")
