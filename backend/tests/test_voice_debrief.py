"""Debrief dynamic variables for the voice agent: the open gap questions and the step titles."""

from pathlib import Path

import pytest

from app.auth import AuthUser
from app.repo import _memory, get_repo
from app.routers import sessions as sessions_router
from app.routers.voice import MAX_GAP_CHARS, MAX_GAPS, format_gaps
from app.schemas import Gap
from app.services import gaps

from .test_voice import _setup, client, fake_elevenlabs, new_session  # noqa: F401  (autouse fixture reused)


@pytest.fixture(autouse=True)
def _clean():
    gaps.reset_state()
    yield
    gaps.reset_state()


async def _debrief_vars(c, sid):
    r = await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "debrief"})
    assert r.status_code == 200
    return r.json()["dynamic_variables"]


async def test_debrief_gaps_are_a_numbered_list_with_ids_and_steps_summary():
    fake_elevenlabs()
    async with client() as c:
        sid = await new_session(c)
        gaps.record_candidates(sid, [
            {"id": "q1", "text": "Why cost center 4711?", "anchor_event_id": 1, "priority": 0.9},
            {"id": "q2", "text": "What would make you stop?", "anchor_event_id": 2, "priority": 0.2},
        ])
        await get_repo().upsert_steps(AuthUser("dev-user"), sid, [
            {"idx": 0, "title": "Open invoice", "event_ids": [], "question_ids": [], "status": "closed"},
            {"idx": 1, "title": "Book it", "event_ids": [], "question_ids": [], "status": "closed"},
        ])
        v = await _debrief_vars(c, sid)
    lines = v["gaps"].split("\n")
    assert lines[0].startswith("1. [gap-1] ")
    assert {"Why cost center 4711?", "What would make you stop?"} == {ln.split("] ", 1)[1] for ln in lines}
    assert v["steps_summary"] == "1. Open invoice; 2. Book it"
    assert v["mode"] == "debrief"
    assert set(v) == {"mode", "task_title", "gaps", "steps_summary", "last_screen_summary", "pending_question"}


def test_gaps_are_capped_and_short():
    many = [Gap(id=f"gap-{i}", type="unseen_case", text="x" * 500, priority=0.5) for i in range(20)]
    lines = format_gaps(many).split("\n")
    assert len(lines) == MAX_GAPS
    assert all(len(line) <= MAX_GAP_CHARS + 20 for line in lines)


async def test_nothing_captured_gives_empty_gaps_and_capture_mode_is_unchanged():
    fake_elevenlabs()
    async with client() as c:
        sid = await new_session(c)
        v = await _debrief_vars(c, sid)
        live = (await c.post("/v1/voice/sessions", json={"session_id": sid, "mode": "capture"})).json()
    assert v["gaps"] == "" and v["steps_summary"] == ""
    assert "steps_summary" not in live["dynamic_variables"]
    _memory.clear()
    sessions_router._summaries.clear()


def test_prompt_defines_both_commands_and_uses_variables():
    text = (Path(__file__).resolve().parents[1] / "app" / "prompts" / "interviewer.system.md").read_text()
    for needle in ("[START]", "[EXPLAIN]", "{{gaps}}", "{{steps_summary}}", "log_answer", "submit_teachback", "Did I get it right?"):
        assert needle in text
