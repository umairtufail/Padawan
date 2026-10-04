import pytest

from app.auth import current_user
from app.config import settings
from app.main import app
from app.repo import _memory as store
from app.routers.capture import get_synthesizer
from app.schemas import SkillAuthor
from app.services import segmenter, synthesizer
from tests.helpers import DEV, TRANSCRIPT, client, reply, seed_session, skill_output


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    yield
    app.dependency_overrides.pop(get_synthesizer, None)
    app.dependency_overrides.pop(current_user, None)
    store.clear()


async def context(corrections=None):
    sid = await seed_session()
    events = await store.list_events(DEV, sid)
    utts = await store.list_utterances(DEV, sid)
    steps = segmenter.segment(events, utts, [], closed=True)
    return dict(
        skill_id="sk-1", author=SkillAuthor(id="u", name="Sabine"), session_title="Process invoices", language="en",
        steps=steps, events=events, utterances=utts, questions=[], corrections=corrections or [],
    )


def sequence(*answers):
    """A fake model returning the given answers in turn. Records every user message."""
    it, seen = iter(answers), []

    async def chat(system, user, **kw):
        seen.append(user)
        return reply(next(it))

    chat.seen = seen
    return chat


def test_find_quote_is_verbatim_modulo_case_and_punctuation():
    utts = [{"speaker": "expert", "t_ms": 10, "text": "Equipment over five thousand, is ALWAYS capex!"},
            {"speaker": "agent", "t_ms": 20, "text": "Tell me about limits"}]
    assert synthesizer.find_quote("equipment over five thousand is always capex", utts)["t_ms"] == 10
    assert synthesizer.find_quote("over five thousand", utts)["t_ms"] == 10
    assert synthesizer.find_quote("Equipment over 5000 is capex", utts) is None     # paraphrase
    assert synthesizer.find_quote("tell me about limits", utts) is None            # the agent's words are not quotable
    assert synthesizer.find_quote("capex always", utts) is None                    # words out of order
    assert synthesizer.find_quote("is", utts) is None                              # too short to prove anything


async def test_valid_output_becomes_a_skill_with_provenance():
    ctx = await context(["Hold applies to all suppliers who double-bill in December"])
    skill, domain, attempts, _ = await synthesizer.synthesize(chat=sequence(skill_output()), **ctx)
    assert attempts == 1 and domain == "finance"
    s1, s2 = skill.steps
    assert s1.reason.t_ms == 6000 and s1.reason.quote.startswith("Equipment over five thousand")  # t_ms from the transcript
    assert s1.guardrails[0].t_ms == 8000 and s1.guardrails[0].id == "g1"
    assert s1.screen_moment.t_ms == 5000  # the decision event, not a model guess
    assert s1.decision.type == "judgment" and s1.predict_prompt
    assert s2.reason is None and s2.predict_prompt is None
    assert skill.teachback.corrections == ["Hold applies to all suppliers who double-bill in December"]
    assert skill.author.name == "Sabine"


async def test_bad_quote_is_rejected_and_retried_once_with_feedback():
    bad = skill_output()
    bad["steps"][0]["reason"]["quote"] = "Equipment above 5000 EUR is capex"  # invented
    ctx = await context()
    chat = sequence(bad, skill_output())
    skill, _, attempts, _ = await synthesizer.synthesize(chat=chat, **ctx)
    assert attempts == 2 and len(skill.steps) == 2
    assert "REJECTED" in chat.seen[1] and "Equipment above 5000 EUR" in chat.seen[1] and "REJECTED" not in chat.seen[0]


async def test_two_bad_answers_fail_and_nothing_is_returned():
    bad = skill_output()
    bad["steps"][0]["guardrails"][0]["quote"] = "never made up"
    with pytest.raises(synthesizer.SynthesisError) as e:
        await synthesizer.synthesize(chat=sequence(bad, bad), **await context())
    assert "quote not found" in str(e.value)


@pytest.mark.parametrize("answer", [None, {"steps": []}, skill_output(steps=[{"idx": 99, "title": "x"}])])
async def test_unusable_answers_fail(answer):
    with pytest.raises(synthesizer.SynthesisError):
        await synthesizer.synthesize(chat=sequence(answer, answer), **await context())


async def test_model_errors_and_timeouts_fail_cleanly():
    async def boom(*a, **k):
        raise RuntimeError("nebius down")

    with pytest.raises(synthesizer.SynthesisError):
        await synthesizer.synthesize(chat=boom, **await context())
    with pytest.raises(synthesizer.SynthesisError):
        async def slow(*a, **k):
            import asyncio
            await asyncio.sleep(1)
        await synthesizer.synthesize(chat=slow, timeout_s=0.05, **await context())


async def test_teachback_guardrail_needs_no_quote_but_expert_one_does():
    out = skill_output()
    out["steps"][1]["guardrails"] = [{"type": "exception", "rule": "Hold double-billing suppliers in December", "quote": "", "source": "teachback"}]
    skill, *_ = await synthesizer.synthesize(chat=sequence(out), **await context(["Hold ..."]))
    g = skill.steps[1].guardrails[0]
    assert g.source == "teachback" and g.quote == "" and g.t_ms is None
    out["steps"][1]["guardrails"][0]["source"] = "expert"
    with pytest.raises(synthesizer.SynthesisError):
        await synthesizer.synthesize(chat=sequence(out, out), **await context())


async def test_skill_md_format_and_counts():
    ctx = await context(["Hold applies to all suppliers who double-bill in December"])
    skill, *_ = await synthesizer.synthesize(chat=sequence(skill_output()), **ctx)
    md = synthesizer.render_skill_md(skill)
    assert md.startswith("---\nname: process-supplier-invoices\n")
    assert 'description: "How invoices are coded before month-end."' in md and 'author: "Sabine"' in md
    assert "## 1. Code the invoice to a cost center" in md and "# Steps" in md
    assert '- Why (expert): Equipment over 5000 is capex ("Equipment over five thousand is always capex", 0:06)' in md
    assert "- Stop and ask when: No asset number: stop and ask the controller" in md
    assert "- Check yourself: A 7,200 EUR compressor arrives. Which code?" in md
    assert "Corrections from the expert" in md and "double-bill in December" in md
    assert synthesizer.count_guardrails(skill) == 1


# ---- the endpoint


async def test_teachback_endpoint_saves_a_draft_and_links_the_session():
    chat = sequence(skill_output())

    async def synth(**kw):
        return await synthesizer.synthesize(chat=chat, **kw)

    app.dependency_overrides[get_synthesizer] = lambda: synth
    sid = await seed_session()
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/teachback", json={"confirmed": True, "corrections": ["Hold in December"]})
    body = r.json()
    assert r.status_code == 200 and body["status"] == "draft" and body["steps_count"] == 2 and body["guardrails_count"] == 1
    rec = await store.get_skill(DEV, body["skill_id"])
    assert rec.status == "draft" and rec.author_name == "Dev" and rec.skill_md.startswith("---")
    assert rec.skill_json["steps"][0]["reason"]["quote"].startswith("Equipment")
    session = await store.get_session(DEV, sid)
    assert session.skill_id == rec.id and session.status == "done"
    assert "Corrections" in rec.skill_md and TRANSCRIPT[0]["text"].split(".")[0] in rec.skill_md


async def test_teachback_again_updates_the_same_skill():
    async def synth(**kw):
        return await synthesizer.synthesize(chat=sequence(skill_output()), **kw)

    app.dependency_overrides[get_synthesizer] = lambda: synth
    sid = await seed_session()
    async with client() as c:
        a = (await c.post(f"/v1/sessions/{sid}/teachback", json={})).json()["skill_id"]
        b = (await c.post(f"/v1/sessions/{sid}/teachback", json={})).json()["skill_id"]
    assert a == b and len(await store.list_skills(DEV, None, None, True)) == 1


async def test_teachback_endpoint_failures():
    async def synth(**kw):
        raise synthesizer.SynthesisError(["step 1 reason: quote not found"])

    app.dependency_overrides[get_synthesizer] = lambda: synth
    sid = await seed_session()
    empty = await seed_session(events=[], utterances=[])
    async with client() as c:
        r = await c.post(f"/v1/sessions/{sid}/teachback", json={"confirmed": True})
        assert r.status_code == 502 and r.json()["detail"]["error"] == "synthesis_failed"
        assert (await store.get_session(DEV, sid)).status == "failed"
        assert await store.list_skills(DEV, None, None, True) == []  # nothing saved
        assert (await c.post(f"/v1/sessions/{sid}/teachback", json={"confirmed": False})).status_code == 400
        assert (await c.post(f"/v1/sessions/{empty}/teachback", json={})).status_code == 409
        assert (await c.post("/v1/sessions/nope/teachback", json={})).status_code == 404


# ---- AI name, description and summary


@pytest.mark.parametrize("title", ["New task", "  untitled ", "Untitled 2", "", None, "x " * 12])
async def test_generic_model_title_falls_back_to_a_name_from_the_steps(title):
    ctx = await context()
    ctx["session_title"] = "New task"
    skill, *_ = await synthesizer.synthesize(chat=sequence(skill_output(title=title)), **ctx)
    assert skill.title == "Code the invoice to a cost center"  # first step, never the placeholder


async def test_real_session_title_is_kept_when_the_model_gives_none():
    skill, *_ = await synthesizer.synthesize(chat=sequence(skill_output(title="New task")), **await context())
    assert skill.title == "Process invoices"


async def test_summary_is_kept_and_defaults_to_the_description():
    out = skill_output(title="Re-code supplier invoices to the right cost center.", summary="The Master re-coded invoice 4471 to capex.")
    skill, *_ = await synthesizer.synthesize(chat=sequence(out), **await context())
    assert skill.title == "Re-code supplier invoices to the right cost center"  # trailing period dropped
    assert skill.summary == "The Master re-coded invoice 4471 to capex."
    assert "The Master re-coded invoice 4471 to capex." in synthesizer.render_skill_md(skill)
    skill, *_ = await synthesizer.synthesize(chat=sequence(skill_output()), **await context())
    assert skill.summary == skill.description


def test_placeholder_titles():
    for t in ("New task", "new task!", "Untitled", "Untitled 3", "", "  "):
        assert synthesizer.is_placeholder_title(t)
    assert not synthesizer.is_placeholder_title("New task force invoices")
    assert not synthesizer.is_placeholder_title("Process invoices")


async def test_teachback_names_the_session_when_it_was_a_placeholder():
    async def synth(**kw):
        return await synthesizer.synthesize(chat=sequence(skill_output(summary="Why and how.")), **kw)

    app.dependency_overrides[get_synthesizer] = lambda: synth
    placeholder = await seed_session(title="New task")
    named = await seed_session(title="My own name")
    async with client() as c:
        r = await c.post(f"/v1/sessions/{placeholder}/teachback", json={})
        await c.post(f"/v1/sessions/{named}/teachback", json={})
        listing = (await c.get("/v1/skills?mine=true")).json()
        sessions = {x["session_id"]: x for x in (await c.get("/v1/sessions")).json()}
    assert r.json()["title"] == "Process supplier invoices" and r.json()["summary"] == "Why and how."
    assert sessions[placeholder]["title"] == "Process supplier invoices" and sessions[placeholder]["status"] == "done"
    assert sessions[placeholder]["skill_id"] == r.json()["skill_id"]
    assert (await store.get_session(DEV, placeholder)).title == "Process supplier invoices"
    assert (await store.get_session(DEV, named)).title == "My own name"
    assert r.status_code == 200 and {s["summary"] for s in listing} == {"Why and how."}
