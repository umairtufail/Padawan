import httpx

from scripts.setup_voice_agents import upsert_agent


def test_upsert_agent_prefers_the_configured_runtime_agent() -> None:
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json={})

    with httpx.Client(base_url="https://api.elevenlabs.io/v1/convai", transport=httpx.MockTransport(handler)) as client:
        agent_id = upsert_agent(client, {"name": "Yoda (Interviewer)"}, "agent_runtime")

    assert agent_id == "agent_runtime"
    assert seen == [("PATCH", "/v1/convai/agents/agent_runtime")]
