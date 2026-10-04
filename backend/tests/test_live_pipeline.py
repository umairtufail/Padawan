"""Calls the real Nebius model. Skipped by default. Run: uv run pytest -m live"""

import pytest

from app.config import settings
from app.repo import _memory as store
from app.schemas import SkillAuthor
from app.services import segmenter, synthesizer
from tests.helpers import DEV, seed_session

pytestmark = pytest.mark.live


@pytest.mark.skipif(not settings.nebius_api_key, reason="NEBIUS_API_KEY is empty")
async def test_live_synthesis_every_quote_is_in_the_transcript():
    store.clear()
    sid = await seed_session()
    events = await store.list_events(DEV, sid)
    utts = await store.list_utterances(DEV, sid)
    steps = segmenter.segment(events, utts, [], closed=True)
    skill, _, attempts, _ = await synthesizer.synthesize(
        skill_id="live", author=SkillAuthor(id="u", name="Sabine"), session_title="Process invoices", language="en",
        steps=steps, events=events, utterances=utts, questions=[], corrections=[], timeout_s=90,
    )
    quotes = [s.reason.quote for s in skill.steps if s.reason] + [g.quote for s in skill.steps for g in s.guardrails]
    assert skill.steps and quotes
    assert all(synthesizer.find_quote(q, utts) for q in quotes)
    store.clear()
