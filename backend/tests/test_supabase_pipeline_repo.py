import json
from datetime import datetime, timezone

import httpx
import pytest

from app.repo import RepoError, SkillRecord
from tests.test_supabase_repo import SID, USER, repo_with

QID = "44444444-4444-4444-4444-444444444444"
SKID = "55555555-5555-5555-5555-555555555555"
ROW = {
    "id": SKID, "author_id": USER.id, "title": "Invoices", "description": "d", "domain": "finance", "language": "en",
    "status": "published", "skill_json": {"id": SKID}, "skill_md": "---", "steps_count": 2, "guardrails_count": 1,
    "created_at": "2026-10-03T21:00:00+00:00", "published_at": "2026-10-04T08:00:00+00:00",
    "profiles": {"display_name": "Sabine"},
}


async def test_add_and_list_utterances():
    def h(req):
        if req.method == "POST":
            assert req.url.path == "/rest/v1/utterances"
            assert json.loads(req.content) == [{"session_id": SID, "t_ms": 5, "speaker": "expert", "text": "hi"}]
            return httpx.Response(201, json=[{"id": 9}])
        assert "order=t_ms.desc,id.desc" in str(req.url) and "limit=10" in str(req.url)
        return httpx.Response(200, json=[{"id": 10, "t_ms": 9, "speaker": "expert", "text": "b"}, {"id": 9, "t_ms": 5, "speaker": "expert", "text": "a"}])

    repo, _ = repo_with(h)
    assert await repo.add_utterances(USER, SID, [{"t_ms": 5, "speaker": "expert", "text": "hi"}]) == [9]
    rows = await repo.list_utterances(USER, SID, limit=10, recent=True)
    assert [r["text"] for r in rows] == ["a", "b"]  # recent: fetched newest first, returned in time order


async def test_recent_events_are_reversed_to_time_order():
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[{"id": 8, "t_ms": 2, "kind": "read", "summary": "y", "payload": None}, {"id": 7, "t_ms": 1, "kind": "read", "summary": "x", "payload": None}]))
    rows = await repo.list_recent_events(USER, SID, 12)
    assert [r["id"] for r in rows] == [7, 8] and "order=id.desc" in str(seen[0].url) and "limit=12" in str(seen[0].url)


async def test_upsert_question_merges_on_id_as_the_user():
    def h(req):
        assert req.method == "POST" and req.url.path == "/rest/v1/questions" and "on_conflict=id" in str(req.url)
        assert req.headers["prefer"] == "resolution=merge-duplicates,return=minimal"
        assert req.headers["authorization"] == "Bearer user-jwt"
        body = json.loads(req.content)
        assert body["id"] == QID and body["session_id"] == SID and body["anchor_event_id"] == 7 and body["why_now"] == {"a": 1}
        return httpx.Response(201)

    repo, _ = repo_with(h)
    await repo.upsert_question(USER, SID, QID, {"phase": "live", "type": "reason", "text": "t", "anchor_event_id": 7, "asked_at_ms": 1, "why_now": {"a": 1}})
    with pytest.raises(RepoError):
        await repo.upsert_question(USER, SID, "bad", {})


async def test_save_answer_checks_question_then_links_utterance():
    calls = []

    def h(req):
        calls.append((req.method, req.url.path))
        if req.method == "GET":
            return httpx.Response(200, json=[{"id": QID}])
        if req.url.path.endswith("/utterances"):
            return httpx.Response(201, json=[{"id": 31}])
        assert req.method == "PATCH" and json.loads(req.content) == {"answer_utterance_id": 31}
        return httpx.Response(204)

    repo, _ = repo_with(h)
    assert await repo.save_answer(USER, SID, QID, 100, "quote") == 31
    assert [m for m, _ in calls] == ["GET", "POST", "PATCH"]

    repo, seen = repo_with(lambda r: httpx.Response(200, json=[]))  # no such question, or not the user's
    assert await repo.save_answer(USER, SID, QID, 1, "q") is None and len(seen) == 1


async def test_upsert_steps_patches_existing_idx_and_inserts_new():
    patched, posted = [], []

    def h(req):
        if req.method == "GET":
            return httpx.Response(200, json=[{"id": "step-uuid-1", "idx": 1}])
        if req.method == "PATCH":
            patched.append((str(req.url), json.loads(req.content)))
            return httpx.Response(204)
        posted.append(json.loads(req.content))
        return httpx.Response(201)

    repo, _ = repo_with(h)
    def step(i, status):
        return {"idx": i, "title": f"s{i}", "t_start_ms": 0, "t_end_ms": 1, "event_ids": [i], "question_ids": [], "status": status}

    await repo.upsert_steps(USER, SID, [step(1, "closed"), step(2, "open")])
    assert "id=eq.step-uuid-1" in patched[0][0] and patched[0][1]["status"] == "closed"
    assert len(posted) == 1 and posted[0][0]["idx"] == 2 and posted[0][0]["session_id"] == SID


async def test_set_session_state_patches_only_given_fields():
    repo, seen = repo_with(lambda r: httpx.Response(204))
    await repo.set_session_state(USER, SID, status="done", skill_id=SKID)
    assert json.loads(seen[0].content) == {"status": "done", "skill_id": SKID}
    await repo.set_session_state(USER, SID)
    assert len(seen) == 1


async def test_save_skill_upserts_as_author_never_from_a_client_author_id():
    def h(req):
        body = json.loads(req.content)
        assert req.url.path == "/rest/v1/skills" and "on_conflict=id" in str(req.url)
        assert body["author_id"] == USER.id and body["id"] == SKID and body["skill_json"] == {"x": 1}
        assert body["status"] == "draft" and body["published_at"] is None
        return httpx.Response(201)

    repo, _ = repo_with(h)
    rec = SkillRecord(id=SKID, author_id="someone-else", author_name="x", title="T", created_at=datetime.now(timezone.utc), skill_json={"x": 1})
    await repo.save_skill(USER, rec)


async def test_get_skill_maps_row_and_hides_invalid_ids():
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[ROW]))
    rec = await repo.get_skill(USER, SKID)
    assert rec.author_name == "Sabine" and rec.steps_count == 2 and rec.published_at.year == 2026
    assert "profiles(display_name)" in str(seen[0].url) or "profiles%28display_name%29" in str(seen[0].url)
    repo, _ = repo_with(lambda r: httpx.Response(200, json=[]))
    assert await repo.get_skill(USER, SKID) is None  # row-level security hides other people's drafts
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[]))
    assert await repo.get_skill(USER, "x'; drop") is None and seen == []


async def test_list_skills_published_with_filters_and_sanitised_search():
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[ROW]))
    await repo.list_skills(USER, 'inv),author_id.eq.x*"', "finance", mine=False)
    q = seen[0].url.params
    assert q["status"] == "eq.published" and q["order"] == "published_at.desc" and q["domain"] == "eq.finance"
    assert q["or"] == "(title.ilike.*invauthor_id.eq.x*,description.ilike.*invauthor_id.eq.x*)"  # no way to inject a filter
    assert "author_id" not in q

    repo, seen = repo_with(lambda r: httpx.Response(200, json=[]))
    await repo.list_skills(USER, None, None, mine=True)
    q = seen[0].url.params
    assert q["author_id"] == f"eq.{USER.id}" and "status" not in q


async def test_author_name_reads_profile_with_fallback():
    repo, _ = repo_with(lambda r: httpx.Response(200, json=[{"display_name": "Sabine"}]))
    assert await repo.author_name(USER) == "Sabine"
    repo, _ = repo_with(lambda r: httpx.Response(200, json=[]))
    assert await repo.author_name(USER) == "Padawan"
