import asyncio
from pathlib import Path

import httpx
import pytest

from app.config import settings
from app.main import app
from app.routers.sessions import get_vision
from app.services.vision import VisionResult
from app.state import store

FRAME = (Path(__file__).parent / "fixtures" / "frames" / "01_erp_cost_center_4711.jpg").read_bytes()


@pytest.fixture(autouse=True)
def _clean():
    store.clear()
    yield
    app.dependency_overrides.clear()
    store.clear()


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def new_session(c: httpx.AsyncClient) -> str:
    r = await c.post("/v1/teach/sessions", json={"title": "Process invoices"})
    assert r.status_code == 201
    return r.json()["session_id"]


async def send(c, sid, t_ms=1000, data=FRAME):
    return await c.post(f"/v1/sessions/{sid}/frames", data={"t_ms": str(t_ms)}, files={"frame": ("f.jpg", data, "image/jpeg")})


def fake(results: list[VisionResult], seen: list | None = None, delay: float = 0.0):
    it = iter(results)

    async def _fake(image, prev_summary="", **kw):
        if seen is not None:
            seen.append(prev_summary)
        if delay:
            await asyncio.sleep(delay)
        return next(it)

    return _fake


def use(fn):
    """Install one shared fake (a fresh one per request would restart its result list)."""
    app.dependency_overrides[get_vision] = lambda: fn


def ok(summary, events=None):
    return VisionResult(screen_summary=summary, events=events or [], latency_ms=5, model="fake")


async def test_create_session():
    async with client() as c:
        r = await c.post("/v1/teach/sessions", json={"title": "T", "description": "d"})
        assert r.status_code == 201
        assert r.json()["title"] == "T" and r.json()["session_id"]


async def test_frame_returns_events_and_threads_summary():
    seen: list = []
    ev = {"kind": "change", "summary": "Cost center 4711 to 0400", "entities": {"from": "4711", "to": "0400"}, "salient": True, "confidence": 0.9}
    use(fake([ok("cost center 4711"), ok("cost center 0400", [ev])], seen))
    async with client() as c:
        sid = await new_session(c)
        r1 = await send(c, sid, 1000)
        r2 = await send(c, sid, 2000)
    assert r1.json()["events"] == [] and r1.json()["screen_summary"] == "cost center 4711"
    body = r2.json()
    assert body["events"][0]["entities"]["to"] == "0400" and body["events"][0]["salient"] is True
    assert body["events"][0]["id"] == 1
    # second frame must receive the first frame's summary as state
    assert seen == ["", "cost center 4711"]


async def test_unknown_session_404():
    async with client() as c:
        r = await send(c, "nope")
    assert r.status_code == 404


async def test_empty_frame_400():
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid, data=b"")
    assert r.status_code == 400


async def test_parse_error_is_skipped_and_keeps_summary():
    seen: list = []
    bad = VisionResult(parse_ok=False, latency_ms=3)
    use(fake([ok("state A"), bad, ok("state B")], seen))
    async with client() as c:
        sid = await new_session(c)
        await send(c, sid, 1)
        r = await send(c, sid, 2)
        await send(c, sid, 3)
    assert r.json()["skipped"] == "parse_error"
    assert seen == ["", "state A", "state A"]  # bad frame did not wipe the state


async def test_timeout_is_skipped(monkeypatch):
    monkeypatch.setattr(settings, "vision_timeout_s", 0.05)
    use(fake([ok("x")], delay=0.5))
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid)
    assert r.json()["skipped"] == "timeout"


async def test_model_exception_is_skipped():
    async def boom(*a, **k):
        raise RuntimeError("nebius down")

    use(boom)
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid)
    assert r.status_code == 200 and r.json()["skipped"] == "vision_error"


async def test_busy_frame_is_skipped_not_queued():
    use(fake([ok("slow")], delay=0.3))
    async with client() as c:
        sid = await new_session(c)
        first = asyncio.create_task(send(c, sid, 1))
        await asyncio.sleep(0.05)
        second = await send(c, sid, 2)
        r1 = await first
    assert second.json()["skipped"] == "busy"
    assert r1.json()["skipped"] is None


async def test_malformed_event_is_dropped_others_kept():
    good = {"kind": "change", "summary": "ok"}
    bad = {"kind": "change"}  # no summary
    use(fake([ok("s", [bad, good])]))
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid)
    assert [e["summary"] for e in r.json()["events"]] == ["ok"]
