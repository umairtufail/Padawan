import json

import httpx
import pytest

from app.auth import AuthUser
from app.repo import RepoError, SupabaseRepo

URL = "https://proj.supabase.co"
USER = AuthUser("11111111-1111-1111-1111-111111111111", "user-jwt")
SID = "22222222-2222-2222-2222-222222222222"


def repo_with(handler) -> tuple[SupabaseRepo, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return handler(req)

    client = httpx.AsyncClient(transport=httpx.MockTransport(wrapped))
    return SupabaseRepo(URL, "pub-key", client), seen


async def test_requests_are_made_as_the_user():
    def h(req):
        return httpx.Response(200, json=[{"id": SID, "user_id": USER.id, "title": "T", "started_at": "2026-10-03T21:00:00+00:00"}])

    repo, seen = repo_with(h)
    await repo.create_session(USER, "T", "", "en")
    req = seen[0]
    assert req.headers["apikey"] == "pub-key"
    assert req.headers["authorization"] == "Bearer user-jwt"  # the user's token, never a service key


async def test_create_session_posts_owner_and_kind():
    def h(req):
        body = json.loads(req.content)
        assert req.method == "POST" and req.url.path == "/rest/v1/sessions"
        assert body == {"user_id": USER.id, "kind": "teach", "title": "Invoices"}
        return httpx.Response(201, json=[{"id": SID, "user_id": USER.id, "title": "Invoices", "started_at": "2026-10-03T21:00:00+00:00"}])

    repo, _ = repo_with(h)
    rec = await repo.create_session(USER, "Invoices", "desc", "de")
    assert rec.id == SID and rec.description == "desc" and rec.language == "de"


async def test_get_session_found_and_hidden():
    rows = [{"id": SID, "user_id": USER.id, "title": "T", "last_screen_summary": "cost center 4711", "started_at": "2026-10-03T21:00:00+00:00"}]
    repo, seen = repo_with(lambda r: httpx.Response(200, json=rows))
    rec = await repo.get_session(USER, SID)
    assert rec.last_summary == "cost center 4711"
    assert f"id=eq.{SID}" in str(seen[0].url)

    repo, _ = repo_with(lambda r: httpx.Response(200, json=[]))  # row-level security hides other users' rows
    assert await repo.get_session(USER, SID) is None


async def test_get_session_bad_id_makes_no_request():
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[]))
    assert await repo.get_session(USER, "not-a-uuid; drop table") is None
    assert seen == []


async def test_save_frame_result_inserts_events_and_updates_summary():
    def h(req):
        if req.method == "POST":
            body = json.loads(req.content)
            assert req.url.path == "/rest/v1/events"
            assert body[0]["session_id"] == SID and body[0]["t_ms"] == 3000
            assert body[0]["payload"]["entities"]["to"] == "0400" and body[0]["payload"]["salient"] is True
            return httpx.Response(201, json=[{"id": 41}, {"id": 42}])
        assert req.method == "PATCH" and req.url.path == "/rest/v1/sessions"
        assert json.loads(req.content) == {"last_screen_summary": "cost center 0400"}
        return httpx.Response(204)

    repo, _ = repo_with(h)
    events = [
        {"kind": "change", "summary": "a", "entities": {"to": "0400"}, "visible_text": [], "salient": True, "confidence": 0.9},
        {"kind": "read", "summary": "b", "entities": {}, "visible_text": [], "salient": False, "confidence": 0.5},
    ]
    assert await repo.save_frame_result(USER, SID, 3000, "cost center 0400", events) == [41, 42]


async def test_save_without_events_only_updates_summary():
    repo, seen = repo_with(lambda r: httpx.Response(204))
    assert await repo.save_frame_result(USER, SID, 1, "s", []) == []
    assert [r.method for r in seen] == ["PATCH"]


async def test_http_error_raises_repo_error():
    repo, _ = repo_with(lambda r: httpx.Response(403, json={"message": "denied"}))
    with pytest.raises(RepoError):
        await repo.create_session(USER, "T", "", "en")


async def test_network_error_raises_repo_error():
    def h(req):
        raise httpx.ConnectError("down")

    repo, _ = repo_with(h)
    with pytest.raises(RepoError):
        await repo.get_session(USER, SID)


async def test_no_token_raises_repo_error():
    repo, _ = repo_with(lambda r: httpx.Response(200, json=[]))
    with pytest.raises(RepoError):
        await repo.get_session(AuthUser("dev-user"), SID)


async def test_list_sessions_reads_embedded_event_counts():
    def h(req):
        assert req.method == "GET" and req.url.path == "/rest/v1/sessions"
        assert "events(count)" in str(req.url) and "order=started_at.desc" in str(req.url)
        return httpx.Response(200, json=[
            {"id": SID, "user_id": USER.id, "title": "A", "last_screen_summary": "s", "started_at": "2026-10-03T21:00:00+00:00", "events": [{"count": 3}]},
            {"id": "33333333-3333-3333-3333-333333333333", "user_id": USER.id, "title": None, "last_screen_summary": None, "started_at": "2026-10-03T20:00:00+00:00", "events": []},
        ])

    repo, _ = repo_with(h)
    rows = await repo.list_sessions(USER)
    assert [r.events_count for r in rows] == [3, 0]
    assert rows[1].title == "" and rows[1].last_summary == ""


async def test_list_events_flattens_payload():
    def h(req):
        assert req.url.path == "/rest/v1/events" and f"session_id=eq.{SID}" in str(req.url) and "order=id.asc" in str(req.url)
        return httpx.Response(200, json=[
            {"id": 7, "t_ms": 3000, "kind": "change", "summary": "x", "payload": {"entities": {"to": "0400"}, "salient": True, "confidence": 0.9, "visible_text": []}},
            {"id": 8, "t_ms": 4000, "kind": "read", "summary": "y", "payload": None},
        ])

    repo, _ = repo_with(h)
    rows = await repo.list_events(USER, SID)
    assert rows[0]["entities"] == {"to": "0400"} and rows[0]["salient"] is True and rows[0]["t_ms"] == 3000
    assert rows[1] == {"id": 8, "t_ms": 4000, "kind": "read", "summary": "y"}


async def test_list_events_bad_session_id_makes_no_request():
    repo, seen = repo_with(lambda r: httpx.Response(200, json=[]))
    assert await repo.list_events(USER, "nope") == []
    assert seen == []
