"""Shared test helpers: a sample teach session (cost center 4711 -> 0400) and fake model replies."""

import httpx

from app.auth import AuthUser
from app.main import app
from app.repo import _memory as store
from app.services.llm import JsonReply

DEV = AuthUser("dev-user")

EVENTS = [
    {"kind": "open", "summary": "Invoice 4471 opened", "entities": {"invoice": "4471"}, "salient": False, "t": 1000},
    {
        "kind": "change", "summary": "Cost center changed from 4711 to 0400 on invoice 4471",
        "entities": {"invoice": "4471", "field": "cost center", "from": "4711", "to": "0400"}, "salient": True, "t": 5000,
    },
    {"kind": "click", "summary": "Invoice 4471 saved", "entities": {"invoice": "4471"}, "salient": False, "t": 9000},
    {"kind": "open", "summary": "Invoice 4472 opened", "entities": {"invoice": "4472"}, "salient": False, "t": 14000},
]

TRANSCRIPT = [
    {"t_ms": 6000, "speaker": "expert", "text": "Equipment over five thousand is always capex."},
    {"t_ms": 8000, "speaker": "expert", "text": "Without an asset number I never book capex, I stop and ask the controller."},
]


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def seed_session(user: AuthUser = DEV, *, events=EVENTS, utterances=TRANSCRIPT, title="Process invoices") -> str:
    """Create a session straight in the memory repo with events and transcript. Returns the session id."""
    rec = await store.create_session(user, title, "", "en")
    for ev in events:
        e = {k: v for k, v in ev.items() if k != "t"}
        e.setdefault("visible_text", [])
        e.setdefault("confidence", 0.9)
        await store.save_frame_result(user, rec.id, ev["t"], "summary", [e])
    if utterances:
        await store.add_utterances(user, rec.id, utterances)
    return rec.id


def reply(data) -> JsonReply:
    return JsonReply(data=data, raw="", model="fake")


def skill_output(**over) -> dict:
    """A model answer for the sample session. Quotes are real spans of TRANSCRIPT."""
    out = {
        "title": "Process supplier invoices",
        "description": "How invoices are coded before month-end.",
        "domain": "finance",
        "steps": [
            {
                "idx": 1, "title": "Code the invoice to a cost center", "screen_description": "Invoice 4471, cost center field",
                "decision": {"type": "judgment", "summary": "Re-coded from opex 4711 to capex 0400"},
                "reason": {"text": "Equipment over 5000 is capex", "quote": "Equipment over five thousand is always capex"},
                "guardrails": [
                    {"type": "stop_and_ask", "rule": "No asset number: stop and ask the controller",
                     "quote": "I never book capex, I stop and ask the controller", "source": "expert"}
                ],
                "predict_prompt": "A 7,200 EUR compressor arrives. Which code?",
            },
            {"idx": 2, "title": "Open the next invoice", "decision": {"type": "routine", "summary": "Opened 4472"},
             "reason": None, "guardrails": []},
        ],
        "global_guardrails": [],
    }
    out.update(over)
    return out
