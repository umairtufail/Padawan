"""ElevenLabs Conversational AI: signed conversation URLs for the Yoda agents.

The API key stays in this process. The browser only ever gets the signed URL (short lived).
"""

import httpx

from ..config import settings

BASE_URL = "https://api.elevenlabs.io"


class ElevenLabsError(Exception):
    """ElevenLabs failed or is not configured. The message never contains the API key."""


async def get_signed_url(agent_id: str, *, transport: httpx.AsyncBaseTransport | None = None) -> str:
    if not settings.elevenlabs_api_key or not agent_id:
        raise ElevenLabsError("voice is not configured")
    try:
        async with httpx.AsyncClient(base_url=BASE_URL, timeout=10, transport=transport) as c:
            r = await c.get(
                "/v1/convai/conversation/get-signed-url",
                params={"agent_id": agent_id},
                headers={"xi-api-key": settings.elevenlabs_api_key},
            )
    except httpx.HTTPError as e:
        raise ElevenLabsError(f"request failed: {type(e).__name__}") from None
    if r.status_code != 200:
        raise ElevenLabsError(f"elevenlabs returned {r.status_code}")
    try:
        url = r.json()["signed_url"]
    except (ValueError, KeyError, TypeError):
        raise ElevenLabsError("unexpected response") from None
    if not isinstance(url, str) or not url:
        raise ElevenLabsError("unexpected response")
    return url
