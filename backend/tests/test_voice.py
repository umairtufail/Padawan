import httpx
import pytest

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import _memory
from app.routers import sessions as sessions_router
from app.routers.voice import get_signed_url_fn
from app.services import elevenlabs

SECRET = "sk_test_SECRET_KEY_123"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    monkeypatch.setattr(settings, "elevenlabs_api_key", SECRET)
    monkeypatch.setattr(settings, "elevenlabs_interviewer_agent_id", "agent_interviewer")
    monkeypatch.setattr(settings, "elevenlabs_tutor_agent_id", "agent_tutor")
    _memory.clear()
    sessions_router._summaries.clear()
    yield
    app.dependency_overrides.clear()
    _memory.clear()
    sessions_router._summaries.clear()


def client():
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def as_user(name):
    async def dep():
        return AuthUser(name)

    app.dependency_overrides[current_user] = dep


def fake_elevenlabs(calls=None, error=None):
    async def _f(agent_id):
        if calls is not None:
            calls.append(agent_id)
        if error:
            raise error
        return f"wss://fake.example/convai?agent_id={agent_id}&token=abc"

    app.dependency_overrides[get_signed_url_fn] = lambda: _f


async def new_session(c, title="Process invoices"):
    return (await c.post("/v1/teach/sessions", json={"title": title})).json()["session_id"]


async def test_capture_returns_interviewer_url_and_variables():
    calls = []
    fake_elevenlabs(calls)
    async with client() as c:
        sid = await new_session(c)
        sessions_router._summaries[sid] = "ERP invoice 4471 open"
        r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "capture", "pending_question": "Why 0400?"})
    assert r.status_code == 200
    body = r.json()
    assert calls == ["agent_interviewer"]
    assert body["agent_id"] == "agent_interviewer"
    assert body["signed_url"].startswith("wss://fake.example/")
    assert body["dynamic_variables"] == {
        "mode": "live", "task_title": "Process invoices", "gaps": "",
        "last_screen_summary": "ERP invoice 4471 open", "pending_question": "Why 0400?",
    }


async def test_debrief_and_tutor_modes():
    calls = []
    fake_elevenlabs(calls)
    async with client() as c:
        sid = await new_session(c)
        d = (await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "debrief"})).json()
        t = (await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "tutor"})).json()
    assert d["agent_id"] == "agent_interviewer" and d["dynamic_variables"]["mode"] == "debrief"
    assert t["agent_id"] == "agent_tutor"
    assert set(t["dynamic_variables"]) == {"task_title", "skill_md", "expert"}


async def test_unknown_session_is_404_and_no_call_is_made():
    calls = []
    fake_elevenlabs(calls)
    async with client() as c:
        r = await c.post("/v1/voice/sessions", json={"session_id": "nope", "mode": "capture"})
    assert r.status_code == 404
    assert calls == []


async def test_someone_elses_session_is_404():
    fake_elevenlabs()
    async with client() as c:
        as_user("alice")
        sid = await new_session(c)
        as_user("bob")
        r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "capture"})
    assert r.status_code == 404


async def test_invalid_mode_is_422():
    fake_elevenlabs()
    async with client() as c:
        sid = await new_session(c)
        r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "shout"})
    assert r.status_code == 422


async def test_elevenlabs_error_is_502_and_key_not_leaked():
    fake_elevenlabs(error=elevenlabs.ElevenLabsError("elevenlabs returned 500"))
    async with client() as c:
        sid = await new_session(c)
        r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "capture"})
    assert r.status_code == 502
    assert SECRET not in r.text


async def test_requires_login_in_admin_mode(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "admin")
    fake_elevenlabs()
    async with client() as c:
        r = await c.post("/v1/voice/sessions", json={"session_id": "x", "mode": "capture"})
    assert r.status_code == 401


async def test_success_response_never_contains_the_key():
    fake_elevenlabs()
    async with client() as c:
        sid = await new_session(c)
        r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "capture"})
    assert SECRET not in r.text


# ---- the service itself, with a mocked HTTP layer


async def test_service_sends_key_header_and_returns_url():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["key"] = request.headers.get("xi-api-key")
        seen["agent"] = request.url.params.get("agent_id")
        seen["path"] = request.url.path
        return httpx.Response(200, json={"signed_url": "wss://x/y"})

    url = await elevenlabs.get_signed_url("agent_a", transport=httpx.MockTransport(handler))
    assert url == "wss://x/y"
    assert seen == {"key": SECRET, "agent": "agent_a", "path": "/v1/convai/conversation/get-signed-url"}


@pytest.mark.parametrize("response", [httpx.Response(401, text=SECRET), httpx.Response(200, json={"nope": 1})])
async def test_service_errors_do_not_carry_the_key(response):
    with pytest.raises(elevenlabs.ElevenLabsError) as e:
        await elevenlabs.get_signed_url("agent_a", transport=httpx.MockTransport(lambda r: response))
    assert SECRET not in str(e.value)


async def test_service_not_configured(monkeypatch):
    monkeypatch.setattr(settings, "elevenlabs_tutor_agent_id", "")
    with pytest.raises(elevenlabs.ElevenLabsError):
        await elevenlabs.get_signed_url("")
