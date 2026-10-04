import json

import httpx

from tests.test_supabase_pipeline_repo import SKID
from tests.test_supabase_repo import SID, USER, repo_with


async def test_learn_attempt_upsert_and_list():
    def h(req):
        if req.method == "POST":
            assert req.url.path == "/rest/v1/learn_attempts" and "on_conflict=session_id,step_idx" in str(req.url)
            assert "merge-duplicates" in req.headers["Prefer"]
            assert json.loads(req.content) == {
                "session_id": SID, "learner_id": USER.id, "skill_id": SKID, "step_idx": 1, "predicted": "0400",
            }
            return httpx.Response(201)
        assert f"session_id=eq.{SID}" in str(req.url) and "order=step_idx.asc" in str(req.url)
        return httpx.Response(200, json=[{"step_idx": 1, "predicted": "0400"}])

    repo, _ = repo_with(h)
    await repo.upsert_attempt(USER, SID, SKID, 1, {"predicted": "0400"})
    assert await repo.list_attempts(USER, SID) == [{"step_idx": 1, "predicted": "0400"}]


async def test_learn_session_is_created_with_kind_and_skill():
    def h(req):
        body = json.loads(req.content)
        assert body["kind"] == "learn" and body["skill_id"] == SKID
        return httpx.Response(201, json=[{"id": SID, "user_id": USER.id, "title": "t", "started_at": "2026-10-04T10:00:00+00:00"}])

    repo, _ = repo_with(h)
    rec = await repo.create_session(USER, "t", "", "en", kind="learn", skill_id=SKID)
    assert rec.kind == "learn" and rec.skill_id == SKID
