import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.auth import AuthUser, current_user
from app.config import settings
from app.main import app
from app.repo import SkillRecord
from app.repo import _memory as store
from tests.helpers import client

ALICE, BOB = AuthUser("alice"), AuthUser("bob")
NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)
MD = "---\nname: invoices\n---\n# Steps\n"


@pytest.fixture(autouse=True)
def _dev(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "dev")
    store.clear()
    yield
    app.dependency_overrides.pop(current_user, None)
    store.clear()


def as_user(user):
    app.dependency_overrides[current_user] = lambda: user


def make(author=ALICE, *, title="Invoices", status="draft", steps=2, domain="finance", minutes=0, md=MD, desc="") -> SkillRecord:
    sid = str(uuid.uuid4())
    json_ = {
        "id": sid, "title": title, "description": desc, "author": {"id": author.id, "name": author.id.title()},
        "created_at": NOW.isoformat(), "language": "en", "steps": [], "global_guardrails": [],
        "teachback": {"confirmed": True, "corrections": []},
    } if steps else None
    rec = SkillRecord(
        id=sid, author_id=author.id, author_name=author.id.title(), title=title, description=desc, domain=domain,
        status=status, skill_json=json_, skill_md=md if steps else None, steps_count=steps, guardrails_count=1,
        created_at=NOW + timedelta(minutes=minutes), published_at=NOW + timedelta(minutes=minutes) if status == "published" else None,
    )
    store._skills[sid] = rec
    return rec


async def test_list_shows_only_published_newest_first_with_author_and_counts():
    old = make(title="Old", status="published", minutes=1)
    new = make(title="New", status="published", minutes=9)
    draft = make(title="Draft")
    as_user(BOB)
    async with client() as c:
        r = await c.get("/v1/skills")
    rows = r.json()
    assert [s["title"] for s in rows] == ["New", "Old"] and draft.id not in {s["id"] for s in rows}
    assert rows[0]["author"] == {"id": "alice", "name": "Alice"} and rows[0]["steps_count"] == 2 and rows[0]["guardrails_count"] == 1
    assert {old.id, new.id} == {s["id"] for s in rows} and "skill" not in rows[0]


async def test_list_filters_and_mine():
    make(title="Supplier invoices", status="published", domain="finance", desc="month-end close")
    make(title="Ticket triage", status="published", domain="support")
    mine_draft = make(author=BOB, title="Bob draft")
    as_user(BOB)
    async with client() as c:
        assert [s["title"] for s in (await c.get("/v1/skills", params={"domain": "support"})).json()] == ["Ticket triage"]
        assert [s["title"] for s in (await c.get("/v1/skills", params={"q": "MONTH-end"})).json()] == ["Supplier invoices"]
        mine = (await c.get("/v1/skills", params={"mine": "true"})).json()
    assert [s["id"] for s in mine] == [mine_draft.id] and mine[0]["status"] == "draft"


async def test_other_users_draft_is_hidden_but_published_is_readable():
    draft = make(author=ALICE)
    pub = make(author=ALICE, status="published")
    as_user(BOB)
    async with client() as c:
        for path in (f"/v1/skills/{draft.id}", f"/v1/skills/{draft.id}/export"):
            assert (await c.get(path)).status_code == 404
        assert (await c.post(f"/v1/skills/{draft.id}/publish")).status_code == 404
        r = await c.get(f"/v1/skills/{pub.id}")
    assert r.status_code == 200 and r.json()["skill"]["id"] == pub.id and r.json()["skill_md"] == MD
    as_user(ALICE)
    async with client() as c:
        assert (await c.get(f"/v1/skills/{draft.id}")).status_code == 200  # the author sees their own draft


async def test_publish_rules():
    draft, empty, pub = make(), make(steps=0), make(status="published")
    as_user(BOB)
    async with client() as c:
        assert (await c.post(f"/v1/skills/{pub.id}/publish")).status_code == 403  # visible, not the author
    as_user(ALICE)
    async with client() as c:
        assert (await c.post(f"/v1/skills/{empty.id}/publish")).status_code == 409  # nothing synthesized
        assert (await c.post("/v1/skills/not-there/publish")).status_code == 404
        r = await c.post(f"/v1/skills/{draft.id}/publish")
        assert r.status_code == 200 and r.json()["status"] == "published" and r.json()["published_at"]
        first = r.json()["published_at"]
        assert (await c.post(f"/v1/skills/{draft.id}/publish")).json()["published_at"] == first  # idempotent
    as_user(BOB)  # now visible for everyone signed in
    async with client() as c:
        assert draft.id in {s["id"] for s in (await c.get("/v1/skills")).json()}


async def test_export_is_markdown_and_needs_skill_md():
    pub = make(status="published", title="Process Supplier Invoices")
    no_md = make(md=None)
    as_user(ALICE)
    async with client() as c:
        r = await c.get(f"/v1/skills/{pub.id}/export")
        assert r.status_code == 200 and r.text == MD
        assert r.headers["content-type"].startswith("text/markdown")
        assert "process-supplier-invoices.SKILL.md" in r.headers["content-disposition"]
        assert (await c.get(f"/v1/skills/{no_md.id}/export")).status_code == 404


async def test_unauthenticated_in_admin_mode(monkeypatch):
    monkeypatch.setattr(settings, "auth_mode", "admin")
    async with client() as c:
        assert (await c.get("/v1/skills")).status_code == 401
