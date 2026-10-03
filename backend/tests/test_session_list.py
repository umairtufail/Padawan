import httpx
import pytest

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import _memory
from app.routers import sessions as sessions_router
from app.routers.sessions import get_vision
from app.services.vision import VisionResult

FRAME = b"\xff\xd8\xff\xe0fake-jpeg"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    _memory.clear()
    sessions_router._locks.clear()
    sessions_router._summaries.clear()
    yield
    app.dependency_overrides.clear()
    _memory.clear()


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def as_user(name):
    async def dep():
        return AuthUser(name)

    app.dependency_overrides[current_user] = dep


def fake_vision(results):
    it = iter(results)

    async def _f(image, prev="", **kw):
        return next(it)

    app.dependency_overrides[get_vision] = lambda: _f


async def new_session(c, title):
    return (await c.post("/v1/teach/sessions", json={"title": title})).json()["session_id"]


async def send(c, sid, t_ms):
    return await c.post(f"/v1/sessions/{sid}/frames", data={"t_ms": str(t_ms)}, files={"frame": ("f.jpg", FRAME, "image/jpeg")})


async def test_list_is_empty_at_first():
    async with client() as c:
        r = await c.get("/v1/sessions")
    assert r.status_code == 200 and r.json() == []


async def test_list_newest_first_with_counts_and_summary():
    ev = {"kind": "change", "summary": "cost center 4711 to 0400", "entities": {"to": "0400"}, "salient": True, "confidence": 0.9}
    fake_vision([VisionResult(screen_summary="cost center 0400", events=[ev, {"kind": "read", "summary": "asset empty"}], latency_ms=3, model="f")])
    async with client() as c:
        first = await new_session(c, "First")
        second = await new_session(c, "Second")
        await send(c, first, 1000)
        rows = (await c.get("/v1/sessions")).json()
    assert [r["title"] for r in rows] == ["Second", "First"]
    by_id = {r["session_id"]: r for r in rows}
    assert by_id[first]["events_count"] == 2 and by_id[first]["last_screen_summary"] == "cost center 0400"
    assert by_id[second]["events_count"] == 0 and by_id[second]["last_screen_summary"] == ""


async def test_detail_returns_events_in_order():
    ev = {"kind": "change", "summary": "cost center 4711 to 0400", "entities": {"from": "4711", "to": "0400"}, "salient": True, "confidence": 0.9}
    fake_vision([VisionResult(screen_summary="s1", events=[], latency_ms=1, model="f"),
                 VisionResult(screen_summary="s2", events=[ev], latency_ms=1, model="f")])
    async with client() as c:
        sid = await new_session(c, "T")
        await send(c, sid, 1000)
        await send(c, sid, 3000)
        r = await c.get(f"/v1/sessions/{sid}")
    d = r.json()
    assert r.status_code == 200 and d["title"] == "T" and d["last_screen_summary"] == "s2"
    assert d["events_count"] == 1
    e = d["events"][0]
    assert e["t_ms"] == 3000 and e["salient"] is True and e["entities"]["to"] == "0400" and e["id"] == 1


async def test_detail_unknown_session_404():
    async with client() as c:
        assert (await c.get("/v1/sessions/does-not-exist")).status_code == 404


async def test_users_only_see_their_own_sessions():
    async with client() as c:
        as_user("alice")
        sid = await new_session(c, "Alice's")
        assert len((await c.get("/v1/sessions")).json()) == 1
        as_user("bob")
        assert (await c.get("/v1/sessions")).json() == []
        assert (await c.get(f"/v1/sessions/{sid}")).status_code == 404
