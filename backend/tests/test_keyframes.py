import io
import json
import uuid

import httpx
import pytest
from PIL import Image

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import SkillRecord
from app.repo import _memory as store
from app.routers import sessions as sessions_router
from app.services import keyframes
from app.services.keyframes import (
    KeyframeError, KeyframeNotFound, MemoryKeyframes, SupabaseKeyframes, get_keyframes, keyframe_path, shrink,
)
from tests.helpers import DEV
from tests.test_frames_endpoint import client, new_session, ok, send, use, fake
from tests.test_skills_api import NOW

CHANGE = {"kind": "change", "summary": "Cost center 4711 to 0400", "entities": {"invoice": "4471", "from": "4711", "to": "0400"},
          "salient": True, "confidence": 0.9}
READ = {"kind": "read", "summary": "Invoice 4471 still open", "entities": {"invoice": "4471"}, "salient": False, "confidence": 0.9}


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    sessions_router._locks.clear()
    sessions_router._summaries.clear()
    sessions_router._off_record.clear()
    keyframes._memory.clear()
    yield
    app.dependency_overrides.clear()
    store.clear()
    keyframes._memory.clear()


def test_shrink_downsizes_and_recompresses():
    big = io.BytesIO()
    Image.new("RGB", (1920, 1080), (200, 30, 30)).save(big, "JPEG", quality=95)
    small = shrink(big.getvalue())
    im = Image.open(io.BytesIO(small))
    assert im.format == "JPEG" and im.width == 640 and im.height == 360
    assert len(small) < len(big.getvalue())
    with pytest.raises(Exception):
        shrink(b"not an image")


async def test_salient_frame_keeps_a_small_keyframe_and_links_it():
    use(fake([ok("cost center 4711"), ok("cost center 0400", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        await send(c, sid, 1000)  # no events: nothing to keep
        assert keyframes._memory.files == {}
        r = await send(c, sid, 2000)
        assert r.status_code == 200 and r.json()["events"][0]["salient"] is True
        path = keyframe_path(DEV.id, sid, 2000)
        assert list(keyframes._memory.files) == [path]
        assert Image.open(io.BytesIO(keyframes._memory.files[path])).width <= 640
        detail = (await c.get(f"/v1/sessions/{sid}")).json()
        assert detail["events"][0]["keyframe_path"] == path
        k = await c.get(f"/v1/sessions/{sid}/keyframes/2000")
        assert k.status_code == 200 and k.json()["t_ms"] == 2000 and k.json()["url"].startswith("memory://keyframes/")
        assert k.json()["expires_in"] == keyframes.SIGNED_URL_TTL_S
        assert (await c.get(f"/v1/sessions/{sid}/keyframes/1000")).status_code == 404
        assert (await c.get(f"/v1/sessions/{uuid.uuid4()}/keyframes/2000")).status_code == 404


async def test_step_boundary_keeps_a_keyframe_but_a_quiet_frame_does_not():
    quiet = {**READ, "summary": "still on it"}
    nav = {"kind": "navigate", "summary": "Opened supplier list", "entities": {}, "salient": False, "confidence": 0.9}
    use(fake([ok("a", [READ]), ok("b", [quiet]), ok("c", [nav])]))
    async with client() as c:
        sid = await new_session(c)
        for t in (1000, 2000, 3000):
            await send(c, sid, t)
    paths = set(keyframes._memory.files)
    # first event of the session opens step 1, the navigation opens step 2, the quiet read in between is skipped
    assert paths == {keyframe_path(DEV.id, sid, 1000), keyframe_path(DEV.id, sid, 3000)}


async def test_steps_carry_keyframe_path_and_signed_url():
    use(fake([ok("a", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        await send(c, sid, 5000)
        steps = (await c.post(f"/v1/sessions/{sid}/finish")).json()["steps"]
        assert steps[0]["keyframe_path"] == keyframe_path(DEV.id, sid, 5000)
        assert steps[0]["keyframe_url"].startswith("memory://keyframes/")
        got = (await c.get(f"/v1/sessions/{sid}/steps")).json()["steps"]
        assert got[0]["keyframe_url"].startswith("memory://keyframes/")


async def test_off_the_record_keeps_nothing():
    use(fake([ok("a", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        await c.post(f"/v1/sessions/{sid}/off-the-record", json={"on": True})
        r = await send(c, sid, 1000)
    assert r.json()["skipped"] == "off_the_record" and keyframes._memory.files == {}


async def test_frame_with_personal_data_keeps_no_pixels():
    pii = {**CHANGE, "summary": "Mail to anna.schmidt@example.com about 4711"}
    use(fake([ok("a", [pii])]))
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid, 1000)
    assert r.status_code == 200 and r.json()["events"] and keyframes._memory.files == {}


class Broken:
    async def upload(self, user, path, jpeg):
        raise KeyframeError("storage down")

    async def signed_url(self, user, path, expires_in=300):
        raise KeyframeError("storage down")


async def test_storage_failure_is_not_fatal():
    app.dependency_overrides[get_keyframes] = lambda: Broken()
    use(fake([ok("a", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid, 1000)
        assert r.status_code == 200 and r.json()["events"][0]["salient"] is True and r.json().get("skipped") is None
        assert (await c.get(f"/v1/sessions/{sid}")).json()["events"][0]["keyframe_path"] is None
        assert (await c.get(f"/v1/sessions/{sid}/keyframes/1000")).status_code == 502
        # signing problems never break the steps listing either
        assert (await c.get(f"/v1/sessions/{sid}/steps")).status_code == 200


async def test_bad_image_is_not_fatal():
    use(fake([ok("a", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        r = await send(c, sid, 1000, data=b"definitely not a jpeg")
    assert r.status_code == 200 and r.json()["events"] and keyframes._memory.files == {}


async def test_a_stranger_cannot_sign_or_read():
    use(fake([ok("a", [CHANGE])]))
    async with client() as c:
        sid = await new_session(c)
        await send(c, sid, 1000)
        app.dependency_overrides[current_user] = lambda: AuthUser("mallory")
        assert (await c.get(f"/v1/sessions/{sid}/keyframes/1000")).status_code == 404  # not their session
    with pytest.raises(KeyframeNotFound):
        await keyframes._memory.signed_url(AuthUser("mallory"), keyframe_path(DEV.id, sid, 1000))
    with pytest.raises(KeyframeError):
        await MemoryKeyframes().upload(AuthUser("mallory"), keyframe_path(DEV.id, sid, 1), b"x")


async def test_skill_detail_signs_keyframes_for_the_author_only():
    path = keyframe_path(DEV.id, "s1", 5000)
    keyframes._memory.files[path] = b"jpeg"
    sid = str(uuid.uuid4())
    skill_json = {
        "id": sid, "title": "T", "author": {"id": DEV.id, "name": "Dev"}, "created_at": NOW.isoformat(), "language": "en",
        "steps": [{"idx": 1, "title": "x", "screen_moment": {"t_ms": 5000, "keyframe_path": path, "description": "d"}},
                  {"idx": 2, "title": "y", "screen_moment": {"t_ms": 6000, "keyframe_path": None, "description": "d"}}],
        "global_guardrails": [], "teachback": {"confirmed": True, "corrections": []},
    }
    store._skills[sid] = SkillRecord(
        id=sid, author_id=DEV.id, author_name="Dev", title="T", created_at=NOW, status="published", published_at=NOW,
        skill_json=skill_json, skill_md="# x", steps_count=2,
    )
    async with client() as c:
        steps = (await c.get(f"/v1/skills/{sid}")).json()["skill"]["steps"]
        assert steps[0]["screen_moment"]["keyframe_url"].startswith("memory://keyframes/")
        assert steps[1]["screen_moment"]["keyframe_url"] is None
        app.dependency_overrides[current_user] = lambda: AuthUser("someone-else")
        other = (await c.get(f"/v1/skills/{sid}")).json()["skill"]["steps"]
        assert other[0]["screen_moment"]["keyframe_url"] is None  # published, but the picture is the author's


# ---------------------------------------------------------------- Supabase Storage client (fake HTTP)

USER = AuthUser("11111111-1111-1111-1111-111111111111", "user-jwt")


def kf_with(handler) -> tuple[SupabaseKeyframes, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(req):
        seen.append(req)
        return handler(req)

    return SupabaseKeyframes("https://proj.supabase.co", "pub-key", httpx.AsyncClient(transport=httpx.MockTransport(wrapped))), seen


async def test_supabase_upload_is_made_as_the_user():
    kf, seen = kf_with(lambda r: httpx.Response(200, json={"Key": "keyframes/x"}))
    await kf.upload(USER, f"{USER.id}/s/1000.jpg", b"jpeg-bytes")
    req = seen[0]
    assert req.method == "POST" and req.url.path == f"/storage/v1/object/keyframes/{USER.id}/s/1000.jpg"
    assert req.headers["authorization"] == "Bearer user-jwt" and req.headers["apikey"] == "pub-key"
    assert req.headers["content-type"] == "image/jpeg" and req.headers["x-upsert"] == "true" and req.content == b"jpeg-bytes"


async def test_supabase_upload_errors_raise():
    kf, _ = kf_with(lambda r: httpx.Response(403, json={"message": "new row violates row-level security policy"}))
    with pytest.raises(KeyframeError):
        await kf.upload(USER, "other-user/s/1.jpg", b"x")

    def boom(r):
        raise httpx.ConnectError("down")

    kf, _ = kf_with(boom)
    with pytest.raises(KeyframeError):
        await kf.upload(USER, "p", b"x")
    with pytest.raises(KeyframeError):
        await SupabaseKeyframes("https://proj.supabase.co", "k").upload(AuthUser("u"), "p", b"x")  # no token


async def test_supabase_signed_url_and_missing_object():
    def h(req):
        assert json.loads(req.content) == {"expiresIn": 300}
        return httpx.Response(200, json={"signedURL": "/object/sign/keyframes/a/b/1.jpg?token=abc"})

    kf, _ = kf_with(h)
    url = await kf.signed_url(USER, "a/b/1.jpg")
    assert url == "https://proj.supabase.co/storage/v1/object/sign/keyframes/a/b/1.jpg?token=abc"

    kf, _ = kf_with(lambda r: httpx.Response(400, json={"error": "not_found", "message": "Object not found"}))
    with pytest.raises(KeyframeNotFound):
        await kf.signed_url(USER, "a/b/1.jpg")
    kf, _ = kf_with(lambda r: httpx.Response(500, text="oops"))
    with pytest.raises(KeyframeError):
        await kf.signed_url(USER, "a/b/1.jpg")
