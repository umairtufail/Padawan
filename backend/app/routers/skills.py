"""Skills API: the Jedi Archives (list, read, publish, export)."""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse

from ..auth import AuthUser, current_user
from ..repo import RepoError, SessionRepo, SkillRecord, get_repo
from ..schemas import SkillAuthor, SkillDetail, SkillJson, SkillSummary
from ..services.keyframes import KeyframeStore, get_keyframes, sign_many
from ..services.synthesizer import slugify

log = logging.getLogger("padawan.skills")
router = APIRouter()


def _summary(r: SkillRecord) -> dict:
    return dict(
        id=r.id, title=r.title, description=r.description, domain=r.domain, language=r.language, status=r.status,
        author=SkillAuthor(id=r.author_id, name=r.author_name), steps_count=r.steps_count,
        guardrails_count=r.guardrails_count, created_at=r.created_at, published_at=r.published_at,
    )


async def _detail(r: SkillRecord, user: AuthUser, store: KeyframeStore) -> SkillDetail:
    skill = None
    if r.skill_json:
        try:
            skill = SkillJson(**r.skill_json)
        except Exception:
            log.warning("skill %s has a skill_json that does not match the schema", r.id)
    if skill is not None and r.author_id == user.id:
        # Keyframes are private to the author (storage RLS), so only the author gets signed URLs.
        urls = await sign_many(store, user, [s.screen_moment.keyframe_path for s in skill.steps if s.screen_moment])
        for s in skill.steps:
            if s.screen_moment:
                s.screen_moment.keyframe_url = urls.get(s.screen_moment.keyframe_path)
    return SkillDetail(**_summary(r), skill=skill, skill_md=r.skill_md)


async def _visible(repo: SessionRepo, user: AuthUser, skill_id: str) -> SkillRecord:
    try:
        rec = await repo.get_skill(user, skill_id)
    except RepoError:
        log.exception("could not load skill")
        raise HTTPException(502, "storage unavailable")
    if rec is None:  # unknown, or someone else's draft
        raise HTTPException(404, "skill not found")
    return rec


@router.get("/skills", response_model=list[SkillSummary])
async def list_skills(
    q: str | None = Query(default=None, max_length=100, description="search in title and description"),
    domain: str | None = Query(default=None, max_length=50),
    mine: bool = Query(default=False, description="list your own skills (drafts too) instead of the published ones"),
    user: AuthUser = Depends(current_user),
    repo: SessionRepo = Depends(get_repo),
) -> list[SkillSummary]:
    try:
        rows = await repo.list_skills(user, q, domain, mine)
    except RepoError:
        log.exception("could not list skills")
        raise HTTPException(502, "storage unavailable")
    return [SkillSummary(**_summary(r)) for r in rows]


@router.get("/skills/{skill_id}", response_model=SkillDetail)
async def get_skill(
    skill_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    store: KeyframeStore = Depends(get_keyframes),
) -> SkillDetail:
    return await _detail(await _visible(repo, user, skill_id), user, store)


@router.post("/skills/{skill_id}/publish", response_model=SkillDetail)
async def publish_skill(
    skill_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo),
    store: KeyframeStore = Depends(get_keyframes),
) -> SkillDetail:
    """Author only. A draft needs a synthesized skill with at least one step. Publishing twice is a no-op."""
    rec = await _visible(repo, user, skill_id)
    if rec.author_id != user.id:
        raise HTTPException(403, "only the author can publish this skill")
    if rec.status == "published":
        return await _detail(rec, user, store)
    if not rec.skill_json or rec.steps_count < 1 or not rec.skill_md:
        raise HTTPException(409, "this skill has no steps yet: finish the teach-back first")
    rec.status = "published"
    rec.published_at = datetime.now(timezone.utc)
    try:
        await repo.save_skill(user, rec)
    except RepoError:
        log.exception("could not publish skill")
        raise HTTPException(502, "storage unavailable")
    return await _detail(rec, user, store)


@router.get("/skills/{skill_id}/export", response_class=PlainTextResponse)
async def export_skill(skill_id: str, user: AuthUser = Depends(current_user), repo: SessionRepo = Depends(get_repo)) -> PlainTextResponse:
    """The SKILL.md an agent can load (text/markdown). Readable for published skills and your own drafts."""
    rec = await _visible(repo, user, skill_id)
    if not rec.skill_md:
        raise HTTPException(404, "this skill has no SKILL.md yet")
    return PlainTextResponse(
        rec.skill_md, media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{slugify(rec.title)}.SKILL.md"'},
    )
