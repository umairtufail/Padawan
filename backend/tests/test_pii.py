import pytest
from .test_frames_endpoint import client, new_session, send

from app.config import settings
from app.main import app
from app.repo import _memory as store
from app.routers import sessions as sessions_router
from app.routers.sessions import get_vision
from app.services.pii import Redactor, is_valid_iban, luhn_ok, redact_frame_result
from app.services.vision import VisionResult

REDACTED = [
    ("Mail anna.schmidt@example.com today", "Mail [EMAIL] today"),
    ("IBAN DE89 3704 0044 0532 0130 00 entered", "IBAN [IBAN] entered"),
    ("IBAN DE89370400440532013000", "IBAN [IBAN]"),
    ("GB82 WEST 1234 5698 7654 32", "[IBAN]"),
    ("DE89 3704 0044 0532 0130 00 TOTAL 100", "[IBAN] TOTAL 100"),
    ("Card 4111 1111 1111 1111", "Card [CARD]"),
    ("Card 4111-1111-1111-1111 exp 12/27", "Card [CARD] exp 12/27"),
    ("Call +49 170 1234567", "Call [PHONE]"),
    ("Tel: 0049 30 12345678", "Tel: [PHONE]"),
    ("Tel 030 / 1234567", "Tel [PHONE]"),
    ("Tel +1 (415) 555-2671", "Tel [PHONE]"),
    ("Herr Müller approved it", "Herr [NAME] approved it"),
    ("Customer: Anna Schmidt-Meier", "Customer: [NAME]"),
]

KEPT = [
    "Invoice INV-2024-00123 total 1.234,56 EUR",
    "Cost center 4711, asset no. empty",
    "Invoice number 4500012345 posted on 2024-01-15",
    "Article 0815 4711 quantity 12",
    "Amount 12345678901234 reference",  # 14 digits, fails Luhn
    "Order DE-4711 and ref AB12 CD34",
    "Customer: ACME Corp GmbH",
    "Version 3.14.159 at 10:45:30",
    "Account DE00 0000 0000 0000 0000 00",  # looks like an IBAN, fails mod 97
    "Card 4111 1111 1111 1112",  # fails Luhn
]


@pytest.mark.parametrize("raw,expected", REDACTED)
def test_redacts(raw, expected):
    assert Redactor().text(raw) == expected


@pytest.mark.parametrize("text", KEPT)
def test_false_positives_kept(text):
    r = Redactor()
    assert r.text(text) == text
    assert r.total == 0


def test_validators():
    assert is_valid_iban("DE89 3704 0044 0532 0130 00")
    assert not is_valid_iban("DE89 3704 0044 0532 0130 01")
    assert luhn_ok("4111111111111111")
    assert not luhn_ok("4111111111111112")


def test_counts_and_nested_fields():
    summary, events, n = redact_frame_result(
        "Form of anna@x.org, cost center 4711",
        [
            {
                "summary": "Typed IBAN DE89370400440532013000",
                "visible_text": ["a@b.io", "4711"],
                "entities": {"mail": "c@d.eu", "cost_center": "4711"},
            }
        ],
    )
    assert summary == "Form of [EMAIL], cost center 4711"
    assert events[0]["summary"] == "Typed IBAN [IBAN]"
    assert events[0]["visible_text"] == ["[EMAIL]", "4711"]
    assert events[0]["entities"] == {"mail": "[EMAIL]", "cost_center": "4711"}
    assert n == 4


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    sessions_router._locks.clear()
    sessions_router._summaries.clear()
    sessions_router._off_record.clear()
    yield
    app.dependency_overrides.clear()
    store.clear()
    sessions_router._off_record.clear()


async def test_endpoint_redacts_before_store_and_next_prompt():
    seen: list[str] = []

    async def fake(image, prev_summary="", **kw):
        seen.append(prev_summary)
        return VisionResult(
            screen_summary="Cost center 4711, payee anna@example.com",
            events=[
                {
                    "kind": "type",
                    "summary": "Typed DE89 3704 0044 0532 0130 00",
                    "visible_text": ["+49 170 1234567"],
                    "salient": True,
                }
            ],
        )

    app.dependency_overrides[get_vision] = lambda: fake
    async with client() as c:
        sid = await new_session(c)
        body = (await send(c, sid)).json()
        await send(c, sid, 2000)
        detail = (await c.get(f"/v1/sessions/{sid}")).json()
    text = str(body) + str(detail) + str(seen)
    for raw in ("anna@example.com", "DE89", "170 1234567"):
        assert raw not in text
    assert "4711" in body["screen_summary"]
    assert seen[1] == "Cost center 4711, payee [EMAIL]"


async def test_off_the_record_skips_and_stores_nothing():
    calls = {"n": 0}

    async def fake(image, prev_summary="", **kw):
        calls["n"] += 1
        return VisionResult(screen_summary="x", events=[{"summary": "y"}])

    app.dependency_overrides[get_vision] = lambda: fake
    async with client() as c:
        sid = await new_session(c)
        r = await c.post(f"/v1/sessions/{sid}/off-the-record", json={"on": True})
        assert r.json() == {"on": True}
        resp = (await send(c, sid)).json()
        assert resp["skipped"] == "off_the_record" and resp["events"] == []
        assert calls["n"] == 0
        assert (await c.get(f"/v1/sessions/{sid}")).json()["events_count"] == 0
        await c.post(f"/v1/sessions/{sid}/off-the-record", json={"on": False})
        assert (await send(c, sid, 3000)).json()["skipped"] is None
        assert calls["n"] == 1


async def test_off_the_record_unknown_session_404():
    async with client() as c:
        r = await c.post("/v1/sessions/nope/off-the-record", json={"on": True})
    assert r.status_code == 404
