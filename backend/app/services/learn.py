"""Learn mode logic: progress state, prediction judging, the mastery report, tutor context for the voice agent.

The report is computed deterministically from the stored `learn_attempts` rows. A model only writes the short
summary text on top (with a fallback sentence), it never touches the numbers.
"""

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field

from ..config import settings
from ..prompts import load_prompt
from ..schemas import SkillJson, SkillStep
from ..schemas_learn import MasteryReport, PracticeItem, ReplayMoment, StepReport
from . import llm
from .guardrail_checker import guardrail_index

log = logging.getLogger("padawan.learn")

MASTERED_AT = 0.75  # a step with a score at or above this counts as mastered
REPEAT_WINDOW_MS = 30_000  # the same verdict inside this window is `repeated`


@dataclass
class LearnState:
    """Per learn session, kept in this process (like the vision lock). `attempts` mirrors learn_attempts."""

    skill_id: str
    current_idx: int
    attempts: dict[int, dict] = field(default_factory=dict)
    seg_start_ms: int | None = None  # when the learner entered current_idx (this process)
    last_t_ms: int = 0
    last_key: tuple | None = None
    last_fire_ms: int = 0


_states: dict[str, LearnState] = {}


def reset_state() -> None:
    _states.clear()


def replay_for(step: SkillStep) -> ReplayMoment:
    m = step.screen_moment
    return ReplayMoment(step_idx=step.idx, t_ms=m.t_ms, description=m.description, keyframe_path=m.keyframe_path)


def get_step(skill: SkillJson, idx: int) -> SkillStep | None:
    return next((s for s in skill.steps if s.idx == idx), None)


# ---------------------------------------------------------------- prediction judging

_STOP = {
    "the", "and", "for", "with", "that", "this", "from", "into", "have", "has", "was", "are", "not", "but", "its",
    "you", "your", "then", "than", "will", "would", "should", "can", "all", "any", "when", "what", "which",
}


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[\w']+", text.casefold()) if (len(t) > 2 or t.isdigit()) and t not in _STOP}


def heuristic_match(predicted: str, expected: str) -> bool:
    """Crude fallback: the prediction mentions at least 40% of the expert decision's key words and one of its numbers (if it has any)."""
    want, got = _tokens(expected), _tokens(predicted)
    if not want or not got:
        return False
    numbers = {t for t in want if any(c.isdigit() for c in t)}
    if numbers and not numbers & got:
        return False
    return len(want & got) / len(want) >= 0.4


async def judge_prediction(
    step: SkillStep, predicted: str, *, chat=llm.chat_json, timeout_s: float | None = None
) -> tuple[bool, str]:
    """(correct, judged_by) with judged_by "model" or "heuristic" (when the model failed or has no key)."""
    expected = step.decision.summary or step.title
    if not (chat is llm.chat_json and not settings.nebius_api_key):
        payload = {
            "STEP": {"title": step.title, "DECISION": expected, "REASON": step.reason.text if step.reason else None},
            "PREDICTED": predicted,
        }
        try:
            reply = await asyncio.wait_for(
                chat(load_prompt("prediction_judge"), json.dumps(payload, ensure_ascii=False), max_tokens=60),
                timeout=timeout_s if timeout_s is not None else settings.learn_model_timeout_s,
            )
            if reply.data is not None and isinstance(reply.data.get("correct"), bool):
                return reply.data["correct"], "model"
        except asyncio.TimeoutError:
            log.warning("prediction judge timed out")
        except Exception:
            log.exception("prediction judge failed")
    return heuristic_match(predicted, expected), "heuristic"


# ---------------------------------------------------------------- the report


def step_score(row: dict | None) -> tuple[float | None, bool]:
    """(score 0..1, reached). Mean of the prediction part (1 right, 0 wrong, absent if none) and the safety part."""
    if not row:
        return None, False
    reached = row.get("started_ms") is not None or row.get("predicted") is not None or row.get("duration_ms") is not None
    if not reached:
        return None, False
    stops, warns = row.get("interventions") or 0, row.get("warnings") or 0
    safety = max(0.0, 1.0 - 0.5 * stops - 0.15 * warns)
    parts = [safety]
    if row.get("correct") is not None:
        parts.append(1.0 if row["correct"] else 0.0)
    return round(sum(parts) / len(parts), 2), True


def _why(step: SkillStep, row: dict | None, rule: str | None) -> str:
    if not row or not (row.get("started_ms") is not None or row.get("predicted") is not None):
        return "You have not reached this step yet."
    bits = []
    if row.get("correct") is False:
        bits.append("your prediction did not match the Master's decision")
    if row.get("interventions"):
        bits.append(f"Yoda had to stop you {row['interventions']} time(s)" + (f" on: {rule}" if rule else ""))
    elif row.get("warnings"):
        bits.append(f"Yoda warned you {row['warnings']} time(s)" + (f" on: {rule}" if rule else ""))
    if step.reason and bits:
        bits.append(f"the Master's reason: {step.reason.text}")
    text = "; ".join(bits)
    return text[:1].upper() + text[1:] + "." if bits else "Worth another look."


def fallback_summary(skill_title: str, score: int, mastered: list[str], practise: list[str]) -> str:
    good = f"You mastered {', '.join(mastered)}." if mastered else "No step is mastered yet."
    todo = f" Practise next: {', '.join(practise)}." if practise else " Nothing left to practise."
    return f"{skill_title}: mastery {score} out of 100. {good}{todo}"


def build_report(
    session_id: str, skill_id: str, skill: SkillJson, attempts: list[dict], *, open_segment: tuple[int, int] | None = None
) -> MasteryReport:
    """Deterministic. `open_segment` = (step idx, ms) is the time on the step the learner is on right now."""
    rows = {int(a["step_idx"]): a for a in attempts}
    index = guardrail_index(skill)
    steps: list[StepReport] = []
    practise: list[tuple[float, PracticeItem]] = []
    total_score = 0.0
    for s in skill.steps:
        row = rows.get(s.idx)
        score, reached = step_score(row)
        dur = (row or {}).get("duration_ms")
        if open_segment and open_segment[0] == s.idx:
            dur = (dur or 0) + max(0, open_segment[1])
        gid = (row or {}).get("guardrail_id")
        rule = index[gid][0].rule if gid in index else None
        if not reached:
            result = "not_reached"
        else:
            result = "mastered" if (score or 0) >= MASTERED_AT else "practise"
            total_score += score or 0
        steps.append(StepReport(
            step_idx=s.idx, title=s.title, decision_type=s.decision.type, reached=reached,
            predicted=(row or {}).get("predicted"), predicted_right=(row or {}).get("correct"),
            interventions=(row or {}).get("interventions") or 0, warnings=(row or {}).get("warnings") or 0,
            guardrail_id=gid, time_ms=dur, score=score or 0.0, result=result,
        ))
        if result != "mastered":
            practise.append((score if score is not None else -1.0, PracticeItem(
                step_idx=s.idx, title=s.title, why=_why(s, row, rule), guardrail_id=gid, rule=rule,
            )))
    practise.sort(key=lambda p: (p[0], p[1].step_idx))  # worst first, unreached steps last of the practise ones
    practise_items = [p for _, p in practise if rows.get(p.step_idx)] + [p for _, p in practise if not rows.get(p.step_idx)]
    total = len(skill.steps)
    score_pct = int(100 * total_score / total + 0.5) if total else 0  # round half up
    mastered = [s.title for s in steps if s.result == "mastered"]
    return MasteryReport(
        session_id=session_id, skill_id=skill_id, skill_title=skill.title, mastery_score=score_pct,
        steps_total=total, steps_reached=sum(s.reached for s in steps), steps_mastered=len(mastered),
        predictions_total=sum(1 for s in steps if s.predicted_right is not None),
        predictions_right=sum(1 for s in steps if s.predicted_right),
        interventions_total=sum(s.interventions for s in steps), warnings_total=sum(s.warnings for s in steps),
        time_total_ms=sum(s.time_ms or 0 for s in steps), steps=steps, practise_next=practise_items,
        summary=fallback_summary(skill.title, score_pct, mastered, [p.title for p in practise_items[:3]]),
        summary_source="fallback",
    )


async def add_summary(report: MasteryReport, skill: SkillJson, *, chat=llm.chat_json, timeout_s: float | None = None) -> None:
    """Replace the fallback summary with a model-written one when that works. Never raises."""
    if chat is llm.chat_json and not settings.nebius_api_key:
        return
    payload = {
        "SKILL": {"title": skill.title, "language": skill.language},
        "MASTERY_SCORE": report.mastery_score,
        "STEPS": [
            {"title": s.title, "result": s.result,
             "prediction": None if s.predicted_right is None else ("right" if s.predicted_right else "wrong"),
             "stops": s.interventions, "warnings": s.warnings}
            for s in report.steps
        ],
        "PRACTISE_NEXT": [p.title for p in report.practise_next],
    }
    try:
        reply = await asyncio.wait_for(
            chat(load_prompt("mastery_summary"), json.dumps(payload, ensure_ascii=False), max_tokens=300),
            timeout=timeout_s if timeout_s is not None else settings.learn_model_timeout_s,
        )
        text = str((reply.data or {}).get("summary") or "").strip()
    except Exception:
        log.warning("mastery summary failed, using the fallback")
        return
    if text:
        report.summary, report.summary_source = text[:600], "model"


# ---------------------------------------------------------------- voice tutor context


def tutor_context(skill: SkillJson, current_idx: int) -> dict[str, str]:
    """Extra dynamic variables for the tutor agent (see routers/voice.py)."""
    steps = [
        f"{s.idx}. {s.title} [{s.decision.type}] " + (f"decision: {s.decision.summary}" if s.decision.summary else "")
        + (f" | reason: {s.reason.text}" if s.reason else "")
        for s in skill.steps
    ]
    index = guardrail_index(skill)
    guards = [
        f"{gid} ({'whole task' if sidx is None else f'step {sidx}'}, {g.type}): {g.rule}" for gid, (g, sidx) in index.items()
    ]
    cur = get_step(skill, current_idx) or (skill.steps[0] if skill.steps else None)
    return {
        "skill_steps": "\n".join(x.strip() for x in steps) or "(none)",
        "skill_guardrails": "\n".join(guards) or "(none)",
        "current_step": f"{cur.idx}. {cur.title}" if cur else "(none)",
        "current_step_idx": str(cur.idx) if cur else "0",
    }
