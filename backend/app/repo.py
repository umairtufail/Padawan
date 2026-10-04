"""Where sessions, events and the running screen summary live.

- MemoryRepo: in-process, for `dev` mode and tests.
- SupabaseRepo: Postgres through Supabase's REST API, called AS THE USER (their access token), so the
  database row-level security enforces ownership. No service-role key is needed or used.
"""

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

import httpx

from .auth import AuthUser
from .config import settings


class RepoError(Exception):
    """Storage failed (network, permissions, bad response)."""


@dataclass
class SessionRecord:
    id: str
    user_id: str
    title: str
    created_at: datetime
    last_summary: str = ""
    description: str = ""
    language: str = "en"
    events_count: int = 0
    skill_id: str | None = None
    status: str = "live"
    kind: str = "teach"  # teach | learn
    mastery_score: int | None = None  # learn sessions: set when finished
    skill_title: str = ""
    steps_total: int = 0
    steps_done: int = 0


@dataclass
class SkillRecord:
    id: str
    author_id: str
    author_name: str
    title: str
    created_at: datetime
    description: str = ""
    domain: str | None = None
    language: str = "en"
    status: str = "draft"  # draft | published
    skill_json: dict | None = None
    skill_md: str | None = None
    steps_count: int = 0
    guardrails_count: int = 0
    published_at: datetime | None = None


ATTEMPT_DEFAULTS = {
    "predicted": None, "actual": None, "correct": None, "intervened": False, "guardrail_id": None,
    "interventions": 0, "warnings": 0, "started_ms": None, "duration_ms": None,
}
ATTEMPT_COLS = "step_idx,predicted,actual,correct,intervened,guardrail_id,interventions,warnings,started_ms,duration_ms"


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


class SessionRepo(Protocol):
    async def create_session(
        self, user: AuthUser, title: str, description: str, language: str, *, kind: str = "teach", skill_id: str | None = None
    ) -> SessionRecord: ...

    async def get_session(self, user: AuthUser, session_id: str) -> SessionRecord | None: ...

    async def save_frame_result(
        self, user: AuthUser, session_id: str, t_ms: int, summary: str, events: list[dict]
    ) -> list[int]:
        """Store the new screen summary and the events. Returns one id per event, in order."""
        ...

    async def list_sessions(self, user: AuthUser) -> list[SessionRecord]:
        """The user's sessions, newest first, each with its events_count."""
        ...

    async def list_events(self, user: AuthUser, session_id: str, limit: int = 200) -> list[dict]:
        """Events of one session in order, each with id, t_ms, kind, summary, entities, visible_text, salient, confidence."""
        ...

    async def list_recent_events(self, user: AuthUser, session_id: str, n: int) -> list[dict]:
        """The last n events of the session, in order."""
        ...

    # transcript
    async def add_utterances(self, user: AuthUser, session_id: str, items: list[dict]) -> list[int]:
        """Store lines {t_ms, speaker, text}. Returns one id per line."""
        ...

    async def list_utterances(self, user: AuthUser, session_id: str, limit: int = 500, recent: bool = False) -> list[dict]:
        """Lines {id, t_ms, speaker, text} in time order. recent=True keeps the LAST `limit` lines."""
        ...

    # questions
    async def upsert_question(self, user: AuthUser, session_id: str, question_id: str, fields: dict) -> None:
        """Create or update a question row with this id. fields: phase, type, text, anchor_event_id, asked_at_ms, why_now."""
        ...

    async def list_questions(self, user: AuthUser, session_id: str) -> list[dict]:
        """Rows {id, phase, type, text, anchor_event_id, asked_at_ms, answer_utterance_id, why_now}, oldest first."""
        ...

    async def save_answer(self, user: AuthUser, session_id: str, question_id: str, t_ms: int, text: str) -> int | None:
        """Store `text` as an expert utterance and link it to the question. Returns the utterance id, None if no such question."""
        ...

    # steps
    async def list_steps(self, user: AuthUser, session_id: str) -> list[dict]:
        """steps_draft rows {idx, title, t_start_ms, t_end_ms, event_ids, question_ids, status} ordered by idx."""
        ...

    async def upsert_steps(self, user: AuthUser, session_id: str, steps: list[dict]) -> None:
        """Insert or update steps by (session, idx)."""
        ...

    async def set_session_state(
        self, user: AuthUser, session_id: str, *, status: str | None = None, skill_id: str | None = None,
        mastery_score: int | None = None,
    ) -> None: ...

    async def list_learn_sessions(self, user: AuthUser) -> list[SessionRecord]:
        """The caller's own learn sessions newest first, with skill_title, steps_total, steps_done, mastery_score."""
        ...

    async def skill_stats(self, user: AuthUser, skill_ids: list[str]) -> dict[str, tuple[int, float | None]]:
        """{skill_id: (distinct learners, average mastery of finished sessions or None)} for skills the caller can
        see. Aggregates only: never who learned."""
        ...

    # learn mode: one row per (learn session, skill step)
    async def upsert_attempt(self, user: AuthUser, session_id: str, skill_id: str, step_idx: int, fields: dict) -> None:
        """Create or update the row for this step. Only the given fields change.
        fields: predicted, actual, correct, intervened, guardrail_id, interventions, warnings, started_ms, duration_ms."""
        ...

    async def list_attempts(self, user: AuthUser, session_id: str) -> list[dict]:
        """Rows {step_idx, predicted, actual, correct, intervened, guardrail_id, interventions, warnings, started_ms, duration_ms} by step_idx."""
        ...

    # skills
    async def author_name(self, user: AuthUser) -> str: ...

    async def save_skill(self, user: AuthUser, rec: SkillRecord) -> None:
        """Insert or update the user's own skill row (by id)."""
        ...

    async def get_skill(self, user: AuthUser, skill_id: str) -> SkillRecord | None:
        """A published skill, or one of the user's own drafts. None otherwise."""
        ...

    async def list_skills(self, user: AuthUser, q: str | None, domain: str | None, mine: bool) -> list[SkillRecord]:
        """Published skills newest first (or, with mine=True, all the user's own skills newest first)."""
        ...


# ---------------------------------------------------------------- memory


class MemoryRepo:
    def __init__(self) -> None:
        self._sessions: dict[str, SessionRecord] = {}
        self._events: list[dict] = []
        self._next_event_id = 1
        self._utterances: list[dict] = []
        self._next_utt_id = 1
        self._questions: dict[str, dict] = {}
        self._steps: dict[str, dict[int, dict]] = {}
        self._skills: dict[str, SkillRecord] = {}
        self._attempts: dict[tuple[str, int], dict] = {}

    def clear(self) -> None:
        self._sessions.clear()
        self._events.clear()
        self._next_event_id = 1
        self._utterances.clear()
        self._next_utt_id = 1
        self._questions.clear()
        self._steps.clear()
        self._skills.clear()
        self._attempts.clear()

    def _owns(self, user, session_id) -> bool:
        rec = self._sessions.get(session_id)
        return rec is not None and rec.user_id == user.id

    async def list_recent_events(self, user, session_id, n) -> list[dict]:
        rows = await self.list_events(user, session_id, limit=10**9)
        return rows[-n:] if n > 0 else []

    async def add_utterances(self, user, session_id, items) -> list[int]:
        if not self._owns(user, session_id):
            raise RepoError("session not found")
        ids = []
        for it in items:
            self._utterances.append({"id": self._next_utt_id, "session_id": session_id, **it})
            ids.append(self._next_utt_id)
            self._next_utt_id += 1
        return ids

    async def list_utterances(self, user, session_id, limit=500, recent=False) -> list[dict]:
        if not self._owns(user, session_id):
            return []
        rows = sorted((u for u in self._utterances if u["session_id"] == session_id), key=lambda u: (u["t_ms"], u["id"]))
        rows = rows[-limit:] if recent else rows[:limit]
        return [{k: v for k, v in u.items() if k != "session_id"} for u in rows]

    async def upsert_question(self, user, session_id, question_id, fields) -> None:
        if not self._owns(user, session_id):
            raise RepoError("session not found")
        existing = self._questions.get(question_id)
        if existing is not None and existing["session_id"] != session_id:
            raise RepoError("question id belongs to another session")
        row = existing or {"id": question_id, "session_id": session_id, "answer_utterance_id": None, "seq": len(self._questions)}
        row.update(fields)
        self._questions[question_id] = row

    async def list_questions(self, user, session_id) -> list[dict]:
        if not self._owns(user, session_id):
            return []
        rows = sorted((q for q in self._questions.values() if q["session_id"] == session_id), key=lambda q: q["seq"])
        return [{k: v for k, v in q.items() if k not in ("session_id", "seq")} for q in rows]

    async def save_answer(self, user, session_id, question_id, t_ms, text) -> int | None:
        q = self._questions.get(question_id)
        if not self._owns(user, session_id) or q is None or q["session_id"] != session_id:
            return None
        (uid,) = await self.add_utterances(user, session_id, [{"t_ms": t_ms, "speaker": "expert", "text": text}])
        q["answer_utterance_id"] = uid
        return uid

    async def list_steps(self, user, session_id) -> list[dict]:
        if not self._owns(user, session_id):
            return []
        return [dict(s) for _, s in sorted(self._steps.get(session_id, {}).items())]

    async def upsert_steps(self, user, session_id, steps) -> None:
        if not self._owns(user, session_id):
            raise RepoError("session not found")
        bucket = self._steps.setdefault(session_id, {})
        for s in steps:
            bucket[s["idx"]] = dict(s)

    async def set_session_state(self, user, session_id, *, status=None, skill_id=None, mastery_score=None) -> None:
        if not self._owns(user, session_id):
            raise RepoError("session not found")
        rec = self._sessions[session_id]
        if mastery_score is not None:
            rec.mastery_score = mastery_score
        if status is not None:
            rec.status = status
        if skill_id is not None:
            rec.skill_id = skill_id

    async def upsert_attempt(self, user, session_id, skill_id, step_idx, fields) -> None:
        if not self._owns(user, session_id):
            raise RepoError("session not found")
        row = self._attempts.setdefault((session_id, step_idx), {"step_idx": step_idx, **ATTEMPT_DEFAULTS})
        row.update(fields)

    async def list_attempts(self, user, session_id) -> list[dict]:
        if not self._owns(user, session_id):
            return []
        return [dict(r) for (sid, _), r in sorted(self._attempts.items(), key=lambda kv: kv[0][1]) if sid == session_id]

    async def author_name(self, user) -> str:
        return {"admin": "Admin", "dev-user": "Dev"}.get(user.id, user.id)

    async def save_skill(self, user, rec) -> None:
        old = self._skills.get(rec.id)
        if old is not None and old.author_id != user.id:
            raise RepoError("not the author")
        self._skills[rec.id] = rec

    async def get_skill(self, user, skill_id) -> SkillRecord | None:
        rec = self._skills.get(skill_id)
        if rec is None:
            return None
        if rec.status != "published" and rec.author_id != user.id and not self._has_learn_session(user, skill_id):
            return None
        return rec

    def _has_learn_session(self, user, skill_id) -> bool:
        return any(s.kind == "learn" and s.user_id == user.id and s.skill_id == skill_id for s in self._sessions.values())

    async def list_learn_sessions(self, user) -> list[SessionRecord]:
        out = []
        for r in self._sessions.values():
            if r.user_id != user.id or r.kind != "learn":
                continue
            sk = self._skills.get(r.skill_id or "")
            r.skill_title = sk.title if sk else r.title
            r.steps_total = sk.steps_count if sk else 0
            r.steps_done = sum(1 for (sid, _) in self._attempts if sid == r.id)  # steps with any progress
            out.append(r)
        return sorted(out, key=lambda r: r.created_at, reverse=True)

    async def skill_stats(self, user, skill_ids) -> dict[str, tuple[int, float | None]]:
        out = {}
        for sid in skill_ids:
            sk = self._skills.get(sid)
            if sk is None or (sk.status != "published" and sk.author_id != user.id):
                continue
            ss = [s for s in self._sessions.values() if s.kind == "learn" and s.skill_id == sid]
            scores = [s.mastery_score for s in ss if s.status == "done" and s.mastery_score is not None]
            out[sid] = (len({s.user_id for s in ss}), round(sum(scores) / len(scores), 1) if scores else None)
        return out

    async def list_skills(self, user, q, domain, mine) -> list[SkillRecord]:
        rows = [s for s in self._skills.values() if (s.author_id == user.id if mine else s.status == "published")]
        if domain:
            rows = [s for s in rows if (s.domain or "").lower() == domain.lower()]
        if q:
            needle = q.lower()
            rows = [s for s in rows if needle in s.title.lower() or needle in s.description.lower()]
        return sorted(rows, key=lambda s: s.published_at or s.created_at, reverse=True)

    async def create_session(self, user, title, description, language, *, kind="teach", skill_id=None) -> SessionRecord:
        rec = SessionRecord(
            id=str(uuid.uuid4()), user_id=user.id, title=title, description=description,
            language=language, created_at=datetime.now(timezone.utc), kind=kind, skill_id=skill_id,
        )
        self._sessions[rec.id] = rec
        return rec

    async def get_session(self, user, session_id) -> SessionRecord | None:
        rec = self._sessions.get(session_id)
        return rec if rec and rec.user_id == user.id else None

    async def save_frame_result(self, user, session_id, t_ms, summary, events) -> list[int]:
        rec = self._sessions[session_id]
        rec.last_summary = summary
        ids = []
        for ev in events:
            ids.append(self._next_event_id)
            self._events.append({"id": self._next_event_id, "session_id": session_id, "t_ms": t_ms, **ev})
            self._next_event_id += 1
        return ids

    async def list_sessions(self, user) -> list[SessionRecord]:
        mine = [r for r in self._sessions.values() if r.user_id == user.id and r.kind == "teach"]
        for r in mine:
            r.events_count = sum(1 for e in self._events if e["session_id"] == r.id)
        return sorted(mine, key=lambda r: r.created_at, reverse=True)

    async def list_events(self, user, session_id, limit=200) -> list[dict]:
        rec = self._sessions.get(session_id)
        if rec is None or rec.user_id != user.id:
            return []
        return [{k: v for k, v in e.items() if k != "session_id"} for e in self._events if e["session_id"] == session_id][:limit]


# ---------------------------------------------------------------- supabase


class SupabaseRepo:
    def __init__(self, url: str, publishable_key: str, client: httpx.AsyncClient | None = None) -> None:
        self._base = url.rstrip("/") + "/rest/v1"
        self._key = publishable_key
        self._http = client or httpx.AsyncClient(timeout=10.0)

    def _headers(self, user: AuthUser, *, returning: bool = False, prefer: str | None = None) -> dict[str, str]:
        if not user.token:
            raise RepoError("no user token: Supabase storage needs AUTH_MODE=supabase")
        h = {"apikey": self._key, "Authorization": f"Bearer {user.token}", "Content-Type": "application/json"}
        if prefer:
            h["Prefer"] = prefer
        elif returning:
            h["Prefer"] = "return=representation"
        return h

    async def _send(self, method: str, path: str, user: AuthUser, *, returning=False, prefer=None, **kw) -> list[dict]:
        try:
            r = await self._http.request(
                method, self._base + path, headers=self._headers(user, returning=returning, prefer=prefer), **kw
            )
        except httpx.HTTPError as e:
            raise RepoError(f"supabase request failed: {e}") from e
        if r.status_code >= 400:
            raise RepoError(f"supabase {method} {path} -> {r.status_code}: {r.text[:200]}")
        return r.json() if returning and r.content else []

    async def create_session(self, user, title, description, language, *, kind="teach", skill_id=None) -> SessionRecord:
        body = {"user_id": user.id, "kind": kind, "title": title}
        if skill_id:
            body["skill_id"] = skill_id
        rows = await self._send(
            "POST", "/sessions?select=id,user_id,title,started_at", user, returning=True, json=body,
        )
        if not rows:
            raise RepoError("session was not created")
        r = rows[0]
        return SessionRecord(
            id=r["id"], user_id=r["user_id"], title=r["title"] or title,
            created_at=datetime.fromisoformat(r["started_at"]), description=description, language=language,
            kind=kind, skill_id=skill_id,
        )

    async def get_session(self, user, session_id) -> SessionRecord | None:
        try:
            uuid.UUID(session_id)
        except ValueError:
            return None
        rows = await self._send(
            "GET", f"/sessions?id=eq.{session_id}&select=id,user_id,title,last_screen_summary,started_at,skill_id,status,kind&limit=1",
            user, returning=True,
        )
        if not rows:  # not found, or row-level security hides it because it is not the user's
            return None
        r = rows[0]
        return SessionRecord(
            id=r["id"], user_id=r["user_id"], title=r["title"] or "",
            created_at=datetime.fromisoformat(r["started_at"]), last_summary=r["last_screen_summary"] or "",
            skill_id=r.get("skill_id"), status=r.get("status") or "live", kind=r.get("kind") or "teach",
        )

    async def save_frame_result(self, user, session_id, t_ms, summary, events) -> list[int]:
        async def insert_events() -> list[int]:
            if not events:
                return []
            body = [
                {
                    "session_id": session_id, "t_ms": t_ms, "kind": e["kind"], "summary": e["summary"],
                    "payload": {k: e[k] for k in ("entities", "visible_text", "salient", "confidence") if k in e},
                    **({"keyframe_path": e["keyframe_path"]} if e.get("keyframe_path") else {}),
                }
                for e in events
            ]
            rows = await self._send("POST", "/events?select=id", user, returning=True, json=body)
            return [int(r["id"]) for r in rows]

        async def update_summary() -> None:
            await self._send("PATCH", f"/sessions?id=eq.{session_id}", user, json={"last_screen_summary": summary})

        ids, _ = await asyncio.gather(insert_events(), update_summary())
        return ids

    async def list_sessions(self, user) -> list[SessionRecord]:
        rows = await self._send(
            "GET",
            "/sessions?kind=eq.teach&select=id,user_id,title,last_screen_summary,started_at,events(count)&order=started_at.desc&limit=100",
            user, returning=True,
        )
        out = []
        for r in rows:
            counts = r.get("events") or [{}]
            out.append(
                SessionRecord(
                    id=r["id"], user_id=r["user_id"], title=r["title"] or "",
                    created_at=datetime.fromisoformat(r["started_at"]),
                    last_summary=r["last_screen_summary"] or "", events_count=int(counts[0].get("count", 0)),
                )
            )
        return out

    async def list_events(self, user, session_id, limit=200) -> list[dict]:
        try:
            uuid.UUID(session_id)
        except ValueError:
            return []
        rows = await self._send(
            "GET",
            f"/events?session_id=eq.{session_id}&select=id,t_ms,kind,summary,payload,keyframe_path&order=id.asc&limit={int(limit)}",
            user, returning=True,
        )
        return [
            {
                "id": int(r["id"]), "t_ms": r["t_ms"], "kind": r["kind"], "summary": r["summary"],
                **({"keyframe_path": r["keyframe_path"]} if r.get("keyframe_path") else {}),
                **(r.get("payload") or {}),
            }
            for r in rows
        ]

    @staticmethod
    def _check_uuid(value: str) -> bool:
        try:
            uuid.UUID(value)
        except (ValueError, AttributeError, TypeError):
            return False
        return True

    async def list_recent_events(self, user, session_id, n) -> list[dict]:
        if not self._check_uuid(session_id) or n <= 0:
            return []
        rows = await self._send(
            "GET",
            f"/events?session_id=eq.{session_id}&select=id,t_ms,kind,summary,payload,keyframe_path&order=id.desc&limit={int(n)}",
            user, returning=True,
        )
        rows.reverse()
        return [
            {
                "id": int(r["id"]), "t_ms": r["t_ms"], "kind": r["kind"], "summary": r["summary"],
                **({"keyframe_path": r["keyframe_path"]} if r.get("keyframe_path") else {}),
                **(r.get("payload") or {}),
            }
            for r in rows
        ]

    async def add_utterances(self, user, session_id, items) -> list[int]:
        if not self._check_uuid(session_id):
            raise RepoError("bad session id")
        body = [{"session_id": session_id, "t_ms": i["t_ms"], "speaker": i["speaker"], "text": i["text"]} for i in items]
        rows = await self._send("POST", "/utterances?select=id", user, returning=True, json=body)
        return [int(r["id"]) for r in rows]

    async def list_utterances(self, user, session_id, limit=500, recent=False) -> list[dict]:
        if not self._check_uuid(session_id):
            return []
        order = "t_ms.desc,id.desc" if recent else "t_ms.asc,id.asc"
        rows = await self._send(
            "GET",
            f"/utterances?session_id=eq.{session_id}&select=id,t_ms,speaker,text&order={order}&limit={int(limit)}",
            user, returning=True,
        )
        if recent:
            rows.reverse()
        return [{"id": int(r["id"]), "t_ms": r["t_ms"], "speaker": r["speaker"], "text": r["text"]} for r in rows]

    async def upsert_question(self, user, session_id, question_id, fields) -> None:
        if not (self._check_uuid(session_id) and self._check_uuid(question_id)):
            raise RepoError("bad id")
        row = {"id": question_id, "session_id": session_id, **fields}
        # Insert, or update the row with the same id (RLS limits both to the session owner).
        await self._send(
            "POST", "/questions?on_conflict=id", user, prefer="resolution=merge-duplicates,return=minimal", json=row
        )

    async def list_questions(self, user, session_id) -> list[dict]:
        if not self._check_uuid(session_id):
            return []
        rows = await self._send(
            "GET",
            f"/questions?session_id=eq.{session_id}"
            "&select=id,phase,type,text,anchor_event_id,asked_at_ms,answer_utterance_id,why_now"
            "&order=asked_at_ms.asc.nullslast",
            user, returning=True,
        )
        return rows

    async def save_answer(self, user, session_id, question_id, t_ms, text) -> int | None:
        if not (self._check_uuid(session_id) and self._check_uuid(question_id)):
            return None
        found = await self._send(
            "GET", f"/questions?id=eq.{question_id}&session_id=eq.{session_id}&select=id&limit=1", user, returning=True
        )
        if not found:
            return None
        (uid,) = await self.add_utterances(user, session_id, [{"t_ms": t_ms, "speaker": "expert", "text": text}])
        await self._send("PATCH", f"/questions?id=eq.{question_id}", user, json={"answer_utterance_id": uid})
        return uid

    async def list_steps(self, user, session_id) -> list[dict]:
        if not self._check_uuid(session_id):
            return []
        return await self._send(
            "GET",
            f"/steps_draft?session_id=eq.{session_id}"
            "&select=id,idx,title,t_start_ms,t_end_ms,event_ids,question_ids,status,keyframe_path&order=idx.asc",
            user, returning=True,
        )

    async def upsert_steps(self, user, session_id, steps) -> None:
        existing = {r["idx"]: r["id"] for r in await self.list_steps(user, session_id)}
        fields = ("idx", "title", "t_start_ms", "t_end_ms", "event_ids", "question_ids", "status", "keyframe_path")
        new = [{"session_id": session_id, **{k: s.get(k) for k in fields}} for s in steps if s["idx"] not in existing]
        calls = [
            self._send("PATCH", f"/steps_draft?id=eq.{existing[s['idx']]}", user, json={k: s.get(k) for k in fields})
            for s in steps
            if s["idx"] in existing
        ]
        if new:
            calls.append(self._send("POST", "/steps_draft", user, json=new))
        await asyncio.gather(*calls)

    async def set_session_state(self, user, session_id, *, status=None, skill_id=None, mastery_score=None) -> None:
        patch = {
            k: v for k, v in (("status", status), ("skill_id", skill_id), ("mastery_score", mastery_score)) if v is not None
        }
        if patch and self._check_uuid(session_id):
            await self._send("PATCH", f"/sessions?id=eq.{session_id}", user, json=patch)

    async def list_learn_sessions(self, user) -> list[SessionRecord]:
        rows = await self._send(
            "GET", "/sessions", user, returning=True,
            params={
                "kind": "eq.learn", "user_id": f"eq.{user.id}", "order": "started_at.desc", "limit": "100",
                "select": "id,user_id,title,started_at,skill_id,status,mastery_score,"
                          "skills(title,steps_count),learn_attempts(count)",
            },
        )
        out = []
        for r in rows:
            sk = r.get("skills") or {}
            done = (r.get("learn_attempts") or [{}])[0].get("count", 0)
            out.append(SessionRecord(
                id=r["id"], user_id=r["user_id"], title=r["title"] or "", created_at=datetime.fromisoformat(r["started_at"]),
                skill_id=r.get("skill_id"), status=r.get("status") or "live", kind="learn",
                mastery_score=r.get("mastery_score"), skill_title=sk.get("title") or r["title"] or "",
                steps_total=sk.get("steps_count") or 0, steps_done=int(done),
            ))
        return out

    async def skill_stats(self, user, skill_ids) -> dict[str, tuple[int, float | None]]:
        ids = [i for i in skill_ids if self._check_uuid(i)]
        if not ids:
            return {}
        rows = await self._send("POST", "/rpc/skill_stats", user, returning=True, json={"skill_ids": ids})
        return {
            r["skill_id"]: (int(r["learners_count"] or 0), None if r["avg_mastery"] is None else float(r["avg_mastery"]))
            for r in rows
        }

    async def upsert_attempt(self, user, session_id, skill_id, step_idx, fields) -> None:
        if not (self._check_uuid(session_id) and self._check_uuid(skill_id)):
            raise RepoError("bad id")
        row = {"session_id": session_id, "learner_id": user.id, "skill_id": skill_id, "step_idx": step_idx, **fields}
        await self._send(
            "POST", "/learn_attempts?on_conflict=session_id,step_idx",
            user, prefer="resolution=merge-duplicates,return=minimal", json=row,
        )

    async def list_attempts(self, user, session_id) -> list[dict]:
        if not self._check_uuid(session_id):
            return []
        return await self._send(
            "GET", f"/learn_attempts?session_id=eq.{session_id}&select={ATTEMPT_COLS}&order=step_idx.asc",
            user, returning=True,
        )

    async def author_name(self, user) -> str:
        rows = await self._send("GET", f"/profiles?id=eq.{user.id}&select=display_name&limit=1", user, returning=True)
        return (rows[0]["display_name"] if rows else None) or "Padawan"

    _SKILL_COLS = (
        "id,author_id,title,description,domain,language,status,skill_json,skill_md,steps_count,"
        "guardrails_count,created_at,published_at,profiles(display_name)"
    )

    @staticmethod
    def _skill(r: dict) -> SkillRecord:
        prof = r.get("profiles") or {}
        return SkillRecord(
            id=r["id"], author_id=r["author_id"], author_name=prof.get("display_name") or "Padawan",
            title=r["title"], description=r.get("description") or "", domain=r.get("domain"),
            language=r.get("language") or "en", status=r["status"], skill_json=r.get("skill_json"),
            skill_md=r.get("skill_md"), steps_count=r.get("steps_count") or 0,
            guardrails_count=r.get("guardrails_count") or 0, created_at=_dt(r["created_at"]),
            published_at=_dt(r.get("published_at")),
        )

    async def save_skill(self, user, rec) -> None:
        row = {
            "id": rec.id, "author_id": user.id, "title": rec.title, "description": rec.description,
            "domain": rec.domain, "language": rec.language, "status": rec.status, "skill_json": rec.skill_json,
            "skill_md": rec.skill_md, "steps_count": rec.steps_count, "guardrails_count": rec.guardrails_count,
            "published_at": rec.published_at.isoformat() if rec.published_at else None,
        }
        await self._send("POST", "/skills?on_conflict=id", user, prefer="resolution=merge-duplicates,return=minimal", json=row)

    async def get_skill(self, user, skill_id) -> SkillRecord | None:
        if not self._check_uuid(skill_id):
            return None
        rows = await self._send(
            "GET", f"/skills?id=eq.{skill_id}&select={self._SKILL_COLS}&limit=1", user, returning=True
        )  # row-level security hides other people's drafts
        return self._skill(rows[0]) if rows else None

    async def list_skills(self, user, q, domain, mine) -> list[SkillRecord]:
        params: dict[str, str] = {"select": self._SKILL_COLS, "limit": "100"}
        if mine:
            params["author_id"] = f"eq.{user.id}"
            params["order"] = "created_at.desc"
        else:
            params["status"] = "eq.published"
            params["order"] = "published_at.desc"
        if domain:
            params["domain"] = f"eq.{domain}"
        if q:
            term = "".join(ch for ch in q if ch not in ",()*%\\\"'").strip()
            if term:
                params["or"] = f"(title.ilike.*{term}*,description.ilike.*{term}*)"
        rows = await self._send("GET", "/skills", user, returning=True, params=params)
        return [self._skill(r) for r in rows]


# ---------------------------------------------------------------- selection

_memory = MemoryRepo()
_supabase: SupabaseRepo | None = None


def get_repo() -> SessionRepo:
    """Dev and admin modes keep everything in memory. Supabase mode stores it in Postgres."""
    global _supabase
    if settings.auth_mode in ("dev", "admin"):
        return _memory
    if _supabase is None:
        _supabase = SupabaseRepo(settings.supabase_url, settings.supabase_publishable_key)
    return _supabase
