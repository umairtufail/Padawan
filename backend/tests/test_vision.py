import os
from pathlib import Path

import pytest

from app.prompts import load_prompt
from app.services.vision import extract_events, parse_json_object

FRAMES = Path(__file__).parent / "fixtures" / "frames"


def test_prompts_load():
    assert "CHANGED" in load_prompt("vision_events")
    assert "candidates" in load_prompt("question_planner")


def test_parse_plain_json():
    assert parse_json_object('{"a": 1}') == {"a": 1}


def test_parse_fenced_json():
    assert parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}


def test_parse_json_with_prose():
    assert parse_json_object('Here you go: {"a": 1} done') == {"a": 1}


# Live test: calls Nebius with a real frame. Run with: uv run pytest -m live
@pytest.mark.live
@pytest.mark.skipif(not os.environ.get("NEBIUS_API_KEY") and not Path("../.env").exists(), reason="no Nebius key")
async def test_live_cost_center_change():
    first = await extract_events((FRAMES / "01_erp_cost_center_4711.jpg").read_bytes())
    second = await extract_events((FRAMES / "02_erp_cost_center_0400.jpg").read_bytes(), first.screen_summary)
    assert second.parse_ok
    text = " ".join(e.get("summary", "") + str(e.get("entities", "")) for e in second.events)
    assert "0400" in text
