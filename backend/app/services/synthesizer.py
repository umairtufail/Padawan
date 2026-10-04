"""Skill synthesizer: steps + events + transcript + teach-back -> Holocron JSON and SKILL.md.

One model call. Programmatic checks afterwards: every quote must be a verbatim span of ONE expert
utterance (its `t_ms` is then taken from that utterance, not from the model), step ids must exist.
If a check fails the call is repeated once with the problems listed; if it fails again the synthesis
fails (SynthesisError). Nothing unverified is ever saved.
"""

import asyncio
import json
import re
from datetime import datetime, timezone

from ..prompts import load_prompt
from ..schemas import (
    Decision, Guardrail, Reason, ScreenMoment, SkillAuthor, SkillJson, SkillStep, Teachback,
)
from . import llm
from .segmenter import is_decision

MIN_QUOTE_CHARS = 4

# Titles that name nothing. The session title is usually one of these (the app creates it before anything is shown).
PLACEHOLDER_TITLES = {
    "", "new task", "untitled", "untitled task", "untitled session", "new session", "new skill", "task", "skill",
    "session", "screen recording", "new holocron", "holocron", "teaching session", "my task", "test",
}
MAX_TITLE_WORDS = 10  # the prompt asks for 3 to 8; beyond 10 it is a sentence, not a name


def is_placeholder_title(title: str | None) -> bool:
    t = re.sub(r"[^\w ]+", " ", (title or "").casefold())
    t = " ".join(t.split())
    return t in PLACEHOLDER_TITLES or bool(re.fullmatch(r"(new task|untitled)( \d+)?", t))


def clean_title(title: str | None) -> str:
    """One line, no quotes or trailing period. Empty when the title is a placeholder or a whole sentence."""
    t = " ".join(str(title or "").split()).strip(" \"'`.")
    if is_placeholder_title(t) or len(t.split()) > MAX_TITLE_WORDS:
        return ""
    return t


def fallback_title(steps: list[dict], session_title: str = "") -> str:
    """A name derived from the first steps when the model gave none (never 'New task')."""
    names = []
    for st in steps[:2]:
        n = " ".join(str(st.get("title") or "").split()).strip(" .")
        if n and not is_placeholder_title(n):
            names.append(n)
    if names:
        words = names[0].split()
        if len(words) < 3 and len(names) > 1:  # too short to be a name: add the second step
            words += ["/"] + names[1].split()
        return " ".join(words[:8]).rstrip(" ,.")
    return clean_title(session_title) or "Recorded task"


class SynthesisError(Exception):
    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems[:5]))
        self.problems = problems


def _norm(text: str) -> str:
    """Lowercase, unify quotes and dashes, drop punctuation, collapse spaces. Words and order stay."""
    text = text.casefold().replace("’", "'").replace("‘", "'")
    return " ".join(re.sub(r"[^\w']+", " ", text).split())


def find_quote(quote: str, utterances: list[dict]) -> dict | None:
    """The expert utterance that contains `quote` verbatim (modulo case and punctuation), or None."""
    q = _norm(quote)
    if len(q) < MIN_QUOTE_CHARS:
        return None
    for u in utterances:
        if u.get("speaker") == "expert" and f" {q} " in f" {_norm(u['text'])} ":
            return u
    return None


def build_user_message(session_title: str, language: str, steps: list[dict], events: list[dict],
                       utterances: list[dict], questions: list[dict], corrections: list[str]) -> str:
    by_id = {e["id"]: e for e in events}
    by_utt = {u["id"]: u for u in utterances}
    payload = {
        "SESSION": {"title": session_title, "language": language},
        "STEPS": [
            {
                "idx": s["idx"], "title": s["title"], "t_start_ms": s["t_start_ms"], "t_end_ms": s["t_end_ms"],
                "events": [
                    {k: by_id[i].get(k) for k in ("id", "t_ms", "kind", "summary", "entities")}
                    for i in s["event_ids"] if i in by_id
                ],
            }
            for s in steps
        ],
        "TRANSCRIPT": [{"t_ms": u["t_ms"], "speaker": u["speaker"], "text": u["text"]} for u in utterances],
        "QUESTIONS": [
            {
                "type": q["type"], "text": q["text"], "anchor_event_id": q.get("anchor_event_id"),
                "answer": by_utt[q["answer_utterance_id"]]["text"] if q.get("answer_utterance_id") in by_utt else None,
            }
            for q in questions
        ],
        "TEACHBACK_CORRECTIONS": corrections,
    }
    return json.dumps(payload, ensure_ascii=False)


def _screen_moment(step: dict, by_id: dict[int, dict], description: str) -> ScreenMoment:
    evs = [by_id[i] for i in step["event_ids"] if i in by_id]
    pick = next((e for e in evs if is_decision(e)), None) or next((e for e in evs if e.get("salient")), None) or (evs[0] if evs else None)
    return ScreenMoment(
        t_ms=pick["t_ms"] if pick else (step.get("t_start_ms") or 0),
        keyframe_path=(pick or {}).get("keyframe_path"),
        description=description or (pick or {}).get("summary", ""),
    )


def build_skill(
    data: dict,
    *,
    skill_id: str,
    author: SkillAuthor,
    session_title: str,
    language: str,
    steps: list[dict],
    events: list[dict],
    utterances: list[dict],
    corrections: list[str],
    now: datetime | None = None,
) -> tuple[SkillJson | None, list[str]]:
    """Validate the model output. Returns (skill, []) or (None, problems)."""
    problems: list[str] = []
    draft = {s["idx"]: s for s in steps}
    by_id = {e["id"]: e for e in events}
    counter = 0

    def check_quote(quote, where: str, *, allow_empty: bool = False) -> int | None:
        """Returns the t_ms of the utterance holding the quote (or 0 when an empty quote is allowed)."""
        nonlocal problems
        if allow_empty and not str(quote or "").strip():
            return None
        u = find_quote(str(quote or ""), utterances)
        if u is None:
            problems.append(f"{where}: quote not found verbatim in an expert utterance: {str(quote)[:80]!r}")
            return None
        return u["t_ms"]

    def guardrail(raw: dict, where: str) -> Guardrail | None:
        nonlocal counter
        try:
            source = "teachback" if raw.get("source") == "teachback" else "expert"
            t = check_quote(raw.get("quote"), where, allow_empty=source == "teachback")
            if source == "expert" and t is None:
                return None
            counter += 1
            return Guardrail(
                id=f"g{counter}", type=raw["type"], rule=str(raw["rule"]).strip(),
                quote=str(raw.get("quote") or "").strip(), t_ms=t, source=source,
            )
        except (KeyError, ValueError, TypeError):
            problems.append(f"{where}: malformed guardrail")
            return None

    out_steps: list[SkillStep] = []
    seen_idx: set[int] = set()
    for raw in data.get("steps") or []:
        try:
            idx = int(raw["idx"])
        except (KeyError, TypeError, ValueError):
            problems.append("a step has no valid idx")
            continue
        if idx not in draft or idx in seen_idx:
            problems.append(f"step idx {idx} is not an unused draft step")
            continue
        seen_idx.add(idx)
        where = f"step {idx}"
        reason = None
        if raw.get("reason"):
            t = check_quote(raw["reason"].get("quote"), f"{where} reason")
            if t is not None:
                reason = Reason(text=str(raw["reason"].get("text", "")).strip(), quote=str(raw["reason"]["quote"]).strip(), t_ms=t)
        gs = [g for i, r in enumerate(raw.get("guardrails") or []) if (g := guardrail(r, f"{where} guardrail {i + 1}"))]
        dec = raw.get("decision") or {}
        dtype = "judgment" if dec.get("type") == "judgment" else "routine"
        title = str(raw.get("title") or draft[idx]["title"]).strip()
        predict = (str(raw.get("predict_prompt") or "").strip() or None)
        if dtype == "judgment" and not predict:
            predict = f"What would you decide at this step: {title}?"
        out_steps.append(
            SkillStep(
                idx=idx, title=title, screen_moment=_screen_moment(draft[idx], by_id, str(raw.get("screen_description") or "")),
                decision=Decision(type=dtype, summary=str(dec.get("summary") or "").strip()),
                reason=reason, guardrails=gs, predict_prompt=predict if dtype == "judgment" else None,
            )
        )
    glob = [g for i, r in enumerate(data.get("global_guardrails") or []) if (g := guardrail(r, f"global guardrail {i + 1}"))]
    if not out_steps and not problems:
        problems.append("no steps in the output")
    if problems:
        return None, problems
    out_steps.sort(key=lambda s: s.idx)
    steps_for_title = [{"title": s.title} for s in out_steps] or steps
    title = clean_title(data.get("title")) or clean_title(session_title) or fallback_title(steps_for_title)
    description = str(data.get("description") or "").strip()
    skill = SkillJson(
        id=skill_id, title=title, description=description,
        summary=str(data.get("summary") or "").strip() or description,
        author=author, created_at=now or datetime.now(timezone.utc), language=language, steps=out_steps,
        global_guardrails=glob, teachback=Teachback(confirmed=True, corrections=corrections),
    )
    return skill, []


async def synthesize(
    *,
    skill_id: str,
    author: SkillAuthor,
    session_title: str,
    language: str,
    steps: list[dict],
    events: list[dict],
    utterances: list[dict],
    questions: list[dict],
    corrections: list[str],
    chat=llm.chat_json,
    timeout_s: float = 60.0,
) -> tuple[SkillJson, str, int, dict]:
    """Returns (skill, domain, attempts, model output). Raises SynthesisError after the retry also fails."""
    system = load_prompt("skill_synthesizer")
    user = build_user_message(session_title, language, steps, events, utterances, questions, corrections)
    problems: list[str] = []
    for attempt in (1, 2):
        message = user if attempt == 1 else (
            user + "\n\nYOUR PREVIOUS ANSWER WAS REJECTED. Fix these problems and answer again with the full JSON:\n- "
            + "\n- ".join(problems[:10])
        )
        try:
            reply = await asyncio.wait_for(chat(system, message, max_tokens=4000), timeout=timeout_s)
        except asyncio.TimeoutError:
            problems = ["the model timed out"]
            continue
        except Exception as e:  # transport errors etc.: same handling as a bad answer
            problems = [f"model call failed: {type(e).__name__}"]
            continue
        if reply.data is None:
            problems = ["the output was not a JSON object"]
            continue
        skill, problems = build_skill(
            reply.data, skill_id=skill_id, author=author, session_title=session_title, language=language,
            steps=steps, events=events, utterances=utterances, corrections=corrections,
        )
        if skill is not None:
            return skill, str(reply.data.get("domain") or "").strip(), attempt, reply.data
    raise SynthesisError(problems)


# ---------------------------------------------------------------- SKILL.md


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:60].strip("-") or "skill"


def _mmss(t_ms: int | None) -> str:
    s = (t_ms or 0) // 1000
    return f"{s // 60}:{s % 60:02d}"


def render_skill_md(skill: SkillJson) -> str:
    label = {"limit": "Limit", "exception": "Exception", "stop_and_ask": "Stop and ask when"}

    def g_line(g: Guardrail) -> str:
        tail = f' ("{g.quote}", {_mmss(g.t_ms)})' if g.quote else " (teach-back correction)"
        return f"- {label[g.type]}: {g.rule}{tail}"

    out = [
        "---",
        f"name: {slugify(skill.title)}",
        f"description: {json.dumps(skill.description or skill.title, ensure_ascii=False)}",
        f"author: {json.dumps(skill.author.name, ensure_ascii=False)}",
        f"created: {skill.created_at.date().isoformat()}",
        "---",
        f"# {skill.title}",
        "",
    ]
    if skill.description:
        out += [skill.description, ""]
    if skill.summary and skill.summary != skill.description:
        out += [skill.summary, ""]
    out += ["# Steps", ""]
    for s in skill.steps:
        out.append(f"## {s.idx}. {s.title}")
        out.append(f"- Screen: {s.screen_moment.description} (at {_mmss(s.screen_moment.t_ms)})")
        if s.decision.summary:
            out.append(f"- Decision ({s.decision.type}): {s.decision.summary}")
        if s.reason:
            out.append(f'- Why (expert): {s.reason.text} ("{s.reason.quote}", {_mmss(s.reason.t_ms)})')
        out += [g_line(g) for g in s.guardrails]
        if s.predict_prompt:
            out.append(f"- Check yourself: {s.predict_prompt}")
        out.append("")
    if skill.global_guardrails:
        out += ["# Rules for the whole task", ""] + [g_line(g) for g in skill.global_guardrails] + [""]
    if skill.teachback.corrections:
        out += ["# Corrections from the expert (these override the steps above)", ""]
        out += [f"- {c}" for c in skill.teachback.corrections] + [""]
    return "\n".join(out).rstrip() + "\n"


def count_guardrails(skill: SkillJson) -> int:
    return sum(len(s.guardrails) for s in skill.steps) + len(skill.global_guardrails)
