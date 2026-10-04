# Frontend integration guide (backend v0: sessions and frames)

How to run the backend locally and call it from the Next.js app. Everything here was tested end to end.

## 1. Run the backend

You need [uv](https://docs.astral.sh/uv/). The repo-root `.env` is already in the repo with the team keys (private repo), so after `git pull` there is nothing to fill in.

```bash
cd backend
uv sync                         # first time only
uv run fastapi dev app/main.py  # http://localhost:8000  (interactive docs: http://localhost:8000/docs)
```

Check it: `curl localhost:8000/health` returns `{"status":"ok"}`.

CORS already allows `http://localhost:3000`. For another origin (a Vercel preview URL, for example) set `ALLOWED_ORIGINS` in `.env` as a comma-separated list.

## 2. Point the frontend at it

```bash
cd frontend
cp .env.example .env.local      # NEXT_PUBLIC_API_URL=http://localhost:8000
npm install && npm run dev      # http://localhost:3000
```

### Three modes (`AUTH_MODE` in the repo-root `.env`)

| Mode | Login needed? | Where data lives | Use it for |
|---|---|---|---|
| `dev` (default) | No. Every request is one "dev user". | In memory, lost on restart | Building UI quickly, no Supabase account needed |
| `admin` | Yes, log in with the demo account (default `admin` / `admin`) through `POST /v1/auth/login`, then send the returned token | In memory, lost on restart | The deployed demo until Supabase login is wired in the UI |
| `supabase` | Yes, a Supabase access token | Postgres (tables `sessions`, `events`, `utterances`, `questions`, `steps_draft`, `skills`) | The real flow and the demo |

Switch by editing `AUTH_MODE` in `.env` and restarting the backend. The login endpoint below works in `dev` and `admin` modes (in `dev` the token is accepted but not required), so one frontend login flow covers both. In `supabase` mode the backend also needs `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (both public values, already in `.env.example`).

**Sending the token.** After the user logs in with Supabase, send their access token on every call:

```ts
const { data } = await supabase.auth.getSession();
const token = data.session?.access_token;   // get it right before each call, supabase-js refreshes it
fetch(`${API}/v1/...`, { headers: { Authorization: `Bearer ${token}` } });
```

The guide's client below already takes an optional `token`. In `dev` mode it is simply ignored, so you can write the code once.

**What the backend does with the token.** It checks the signature, expiry, audience and issuer against the project's public keys, and uses the user id inside it. It never trusts a user id sent in the body. A missing, expired or invalid token returns `401`. A session that belongs to someone else returns `404`.

**Sessions survive restarts in `supabase` mode** and are stored per user. In `dev` mode they live in memory.

### Demo login (`dev` and `admin` modes)
`POST /v1/auth/login` with JSON `{"username": "admin", "password": "admin"}` returns:

```json
{"access_token": "<jwt>", "token_type": "bearer", "expires_in": 43200, "user": {"id": "admin", "name": "Admin"}}
```

Wrong credentials return `401 {"detail": "invalid credentials"}`. Send the token as `Authorization: Bearer <access_token>` on every other call (`/health` and the login itself are public). The account comes from `ADMIN_USER` and `ADMIN_PASSWORD` in the backend environment; **change both on any public deployment**, because the defaults are guessable. In `supabase` mode this endpoint returns 404.

## 3. The endpoints

### Create a teach session
`POST /v1/teach/sessions` with JSON `{"title": "...", "description": "", "language": "en"}`, returns `201`:

```json
{"session_id": "0b3cc50a-...", "title": "Process supplier invoices", "description": "", "language": "en", "created_at": "2026-10-03T21:00:00Z"}
```

### List and read sessions
- `GET /v1/sessions` returns the caller's sessions, newest first: `[{"session_id", "title", "created_at", "last_screen_summary", "events_count"}]`.
- `GET /v1/sessions/{session_id}` returns the same fields plus `events`: `[{"id", "t_ms", "kind", "summary", "entities", "visible_text", "salient", "confidence"}]` in order (up to 200). `404` for an unknown session or someone else's.

### Send a screen frame
`POST /v1/sessions/{session_id}/frames`, **multipart form** with `t_ms` (milliseconds since the session started) and `frame` (a JPEG).

```json
{
  "t_ms": 3000,
  "screen_summary": "SandboxERP: invoice 4471 open, cost center field 0400, asset no. empty",
  "events": [
    {
      "id": 2, "kind": "change", "salient": true, "confidence": 0.95,
      "summary": "Cost center field changed from 4711 to 0400",
      "entities": {"invoice": "4471", "field": "cost center", "from": "4711", "to": "0400"},
      "visible_text": []
    }
  ],
  "question_candidates": [],
  "step_update": null,
  "latency_ms": 1531,
  "skipped": null
}
```

- `events` is empty when nothing changed. That is normal and common.
- `question_candidates` and `step_update` are always empty for now (coming next). Keep them in your types.
- **`skipped`** is `null` when the frame was analysed. Otherwise it is one of `busy`, `timeout`, `vision_error`, `parse_error`, `storage_error`, `off_the_record`. Just carry on with the next frame, nothing to retry and nothing to show the user.
- **Redaction.** `screen_summary`, event `summary`, `entities` and `visible_text` are redacted on the backend before they are stored or returned: emails, IBANs (mod 97 checked), card numbers (Luhn checked), phone numbers and names after a cue (`Herr`, `Mr.`, `Customer:`) become `[EMAIL]`, `[IBAN]`, `[CARD]`, `[PHONE]`, `[NAME]`. Invoice numbers and cost centers stay. Not a guarantee: free-form names and addresses can slip through.
- **Off the record.** `POST /v1/sessions/{id}/off-the-record` with `{"on": true}` (or `false`) returns `{"on": ...}`. While on, every frame returns `skipped: "off_the_record"`, is not analysed or stored, and is not sent to any model. The client should also stop capturing and mute the mic while it is on. The flag is held in server memory (lost on restart, per instance, not yet persisted); re-send it after a reconnect.
- **Keyframes.** When a frame has a salient event, or its first event opens a new step, the backend keeps a small JPEG of it (at most 640 px wide, quality 60, no EXIF) in the private Supabase Storage bucket `keyframes` at `{user_id}/{session_id}/{t_ms}.jpg`, uploaded with the user's own token so storage row-level security makes it owner-only. The path is saved on the event (`keyframe_path`, visible in the events of `GET /v1/sessions/{id}`) and on the step. Nothing is kept when the session is off the record, when the redactor found personal data in the frame's text (the pixels may show it too), or when the upload fails or takes over 4 s. A storage failure never changes the frame response. Not every frame has a keyframe, and the frames response itself does not mention them.
- Errors: `401` missing or invalid token (supabase mode), `404` unknown session or someone else's, `400` empty frame, `413` frame over 4 MB, `502` storage unavailable.

### Start a voice conversation with Yoda
`POST /v1/voice/sessions` with JSON `{"session_id": "...", "mode": "capture" | "debrief" | "tutor", "pending_question": ""}` (`pending_question` is optional). Needs the same login token as the other calls, and the session must belong to the caller (else `404`). Returns:

```json
{
  "signed_url": "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...&conversation_signature=...",
  "agent_id": "agent_...",
  "dynamic_variables": {"mode": "live", "task_title": "Process supplier invoices", "gaps": "", "last_screen_summary": "...", "pending_question": ""}
}
```

- `capture` and `debrief` use the interviewer agent (`mode` is `live` or `debrief`), `tutor` uses the tutor agent (variables `task_title`, `skill_md`, `expert`). `gaps` (debrief) and `skill_md`/`expert` (tutor) are placeholders until the question planner and skills exist.
- Start the conversation in the browser with the ElevenLabs SDK, passing the `signed_url` and the `dynamic_variables` (for the JS SDK: `Conversation.startSession({ signedUrl, dynamicVariables })`). The browser never sees the API key. The signed URL is short lived: ask for a new one per conversation.
- **The interviewer is silent until you send it a user message starting with `[ASK]`**, for example `[ASK] Why did you change the cost center from 4711 to 0400?`. It then asks that question aloud, in one sentence, and stops. In debrief mode, send `[START]` to make it begin. The tutor greets first and reacts to `[INTERVENE]`.
- Client tools the agents may call (implement them in the page): interviewer `log_answer(question_id, summary)`, `set_off_record(on)`, `submit_teachback(confirmed, corrections)`; tutor `record_prediction(step_idx, predicted)` (return a string saying whether it was right), `show_replay(step_idx)`, `finish_learning()`.
- Errors: `401` bad token, `404` unknown or someone else's session, `422` bad `mode`, `502` ElevenLabs unavailable or voice not configured.
- **Built in the frontend (#28):** `lib/use-agent-conversation.ts` (uses `@elevenlabs/client`, pinned), `lib/pause-controller.ts` (pure rules: screen idle 2 s, expert silent 1.5 s, Yoda quiet, 60 s between questions, 5 per 10 min, a question waiting) and `lib/use-pause-controller.ts` (queue, "why now" trace). Questions come from `question_candidates`; until the planner (#27) lands, a stub makes "why" questions from salient events. With `NEXT_PUBLIC_API_MOCK=1` the voice is scripted (no ElevenLabs, no microphone).
- Agents are created and updated by `cd backend && uv run python -m scripts.setup_voice_agents` (prompts live in `backend/app/prompts/interviewer.system.md` and `tutor.system.md`; re-run the script after editing them). Agent ids are in `.env` as `ELEVENLABS_INTERVIEWER_AGENT_ID` and `ELEVENLABS_TUTOR_AGENT_ID`.

- `question_candidates` is filled only on a frame with a **salient** event (at most 3, best first; empty otherwise, and empty whenever the planner model is slow or fails, which is normal). Each has a `id` (a UUID), a `type` (`reason`, `guardrail`, `limit`, `exception`), the short spoken `text`, `anchor_event_id` (a real event id, from this response or an earlier one) and a `priority` from 0 to 1. The browser's pause controller decides **when** to ask one. When Yoda asks it, call `POST /v1/sessions/{id}/questions/{candidate id}/asked` (section 3b).
- `step_update` is the current open step (`{"idx", "title", "status"}`) as of the last background segmentation, or `null` before the first one. It can lag a few frames behind. The steps themselves are in `GET /v1/sessions/{id}/steps` (and live through Supabase Realtime on `steps_draft`).
- **`skipped`** is `null` when the frame was analysed. Otherwise it is one of `busy`, `timeout`, `vision_error`, `parse_error`, `storage_error`. Just carry on with the next frame, nothing to retry and nothing to show the user.
- Errors: `401` missing or invalid token (supabase mode), `404` unknown session or someone else's, `400` empty frame, `413` frame over 4 MB, `502` storage unavailable.

## 3b. Transcript, questions, steps, finish, teach-back (all need the same token as above)

All of these return `404` for an unknown session or someone else's, and `502 {"detail": "storage unavailable"}` if storage fails. None of them are called per frame.

| Method and path | Body | Response |
|---|---|---|
| `POST /v1/sessions/{id}/utterances` | `{"utterances": [{"t_ms": 6000, "speaker": "expert", "text": "..."}]}` (1 to 200 lines; `speaker`: `expert`, `agent`, `learner`, `tutor`, default `expert`) | `{"stored": 1, "ids": [31]}` |
| `POST /v1/sessions/{id}/questions/{qid}/asked` | `{"type": "reason", "text": "...", "anchor_event_id": 42, "asked_at_ms": 19500, "phase": "live", "why_now": {"pause_ms": 1800}}` (`qid` = the candidate `id`; only `text` is required; calling it again with the same `qid` updates the row) | `{"id", "phase", "type", "text", "anchor_event_id", "asked_at_ms", "answered": false, "why_now"}`. `422` if `qid` is not a UUID |
| `POST /v1/sessions/{id}/answers` | `{"question_id": "<qid>", "quote": "what the expert said", "summary": "", "t_ms": 21000}` (the interviewer tool `log_answer`; the quote is stored as an expert line and linked to the question) | `{"question_id", "utterance_id"}`. `404` if that question was never recorded with `.../asked` |
| `GET /v1/sessions/{id}/steps` | none | `{"steps": [{"idx": 1, "title": "...", "t_start_ms": 1000, "t_end_ms": 9000, "event_ids": [41, 42], "question_ids": ["<qid>"], "status": "open"}]}` |
| `POST /v1/sessions/{id}/finish` | none | `{"session_id", "status": "debrief", "steps": [...all closed], "gaps": [{"id": "gap-1", "type": "missing_reason", "text": "a question for the debrief", "step_idx": 1, "anchor_event_id": 42, "priority": 0.9}]}` |
| `POST /v1/sessions/{id}/teachback` | `{"confirmed": true, "corrections": ["Hold applies to every supplier who double-bills in December"]}` | `{"skill_id", "status": "draft", "steps_count": 4, "guardrails_count": 3, "attempts": 1}` |

Notes:
- **Gap `type`**: `missing_reason`, `missing_guardrail`, `unasked_question`, `unclear_term`, `unseen_case`. Sorted by `priority`, at most 12. `unasked_question` gaps come from planner candidates kept in the backend's memory, so they are lost if the backend restarts mid-session.
- **Teach-back runs synchronously**: it makes one model call (a second only if the quote check rejects the first answer), so expect roughly 3 to 30 s; show a spinner. `400` if `confirmed` is false, `409` if the session captured nothing, `502 {"detail": {"error": "synthesis_failed", "problems": ["..."]}}` if the model could not produce a skill whose quotes all exist in the transcript (nothing is saved, the session is marked `failed`, calling again retries). Calling it again for the same session updates the same skill (and keeps it published if it was).
- **Steps are built in the background** every 10 events or 20 s while frames arrive, and finally by `finish`. A step ends on: a different entity in focus (another invoice), a save or submit, a navigation, a long idle gap, or the expert saying "next" or "okay then".
- **Not done yet**: transcript lines are **not redacted** (the PII ticket), `finish` does not return an ElevenLabs `signed_url`, and the off-record endpoint does not exist.

Keyframes (the expert's screen at a salient moment or at the start of a step):

| Method and path | Response |
|---|---|
| `GET /v1/sessions/{id}/keyframes/{t_ms}` | `{"t_ms": 5000, "url": "https://.../storage/v1/object/sign/keyframes/...?token=...", "expires_in": 300}`. `t_ms` must be the exact time of a frame that has a keyframe (an event's `keyframe_path` ends in `/{t_ms}.jpg`). `404` if the session is not yours or no keyframe was kept there, `502` if storage fails. The URL is short-lived (5 minutes): fetch it right before showing the image, never store it. |

`steps` items (from `GET .../steps` and `finish`) also carry `keyframe_path` and a ready-signed `keyframe_url` (both `null` when the step has no keyframe or signing failed). The database change is migration `20261004120000_keyframes_storage_policies.sql`: a `steps_draft.keyframe_path` column, a 1 MB JPEG-only limit on the bucket, and storage policies so only the owner (first folder = their user id) can read, write or delete.

### Skills (Holocrons) and the Jedi Archives

| Method and path | Response |
|---|---|
| `GET /v1/skills?q=&domain=&mine=` | Published skills, newest first: `[SkillSummary]`. `q` searches title and description, `domain` is an exact match, `mine=true` lists **your own** skills instead (drafts included, newest first). Max 100 |
| `GET /v1/skills/{id}` | `SkillDetail` = `SkillSummary` plus `skill` (the Holocron JSON below, or `null`) and `skill_md`. `404` for an unknown skill or someone else's **draft** |
| `POST /v1/skills/{id}/publish` | The updated `SkillDetail`. Author only: `403` if it is visible but not yours, `404` for someone else's draft, `409` if it has no steps yet. Publishing twice changes nothing |
| `GET /v1/skills/{id}/export` | The `SKILL.md` as `text/markdown` with `Content-Disposition: attachment; filename="<slug>.SKILL.md"`. Readable for published skills and your own drafts |

```json
// SkillSummary
{"id": "uuid", "title": "Process supplier invoices", "description": "...", "domain": "finance", "language": "en",
 "status": "published", "author": {"id": "uuid", "name": "Sabine"}, "steps_count": 4, "guardrails_count": 3,
 "created_at": "2026-10-03T18:00:00Z", "published_at": "2026-10-04T08:00:00Z"}
```

The Holocron JSON (`skill`) is the contract from Notion page 03, with two differences you must handle: `reason` can be `null` (the expert never gave one; the backend never invents a reason), and each guardrail has `source` (`"expert"` or `"teachback"`; teach-back ones have an empty `quote` and `t_ms: null`). `screen_moment.keyframe_path` is the storage path of the step's keyframe, or `null` when none was kept. `GET /v1/skills/{id}` (and publish) adds `screen_moment.keyframe_url`, a 5-minute signed URL, **only when the caller is the author**: keyframes are private to the expert, so a Padawan reading a published skill gets `null` there (sharing them with learners is not built). Guardrail ids are unique across the whole skill (`g1`, `g2`, ...). `predict_prompt` is set only on `judgment` steps.

```json
{
  "id": "uuid", "title": "...", "description": "...", "author": {"id": "uuid", "name": "Sabine"},
  "created_at": "2026-10-03T18:00:00Z", "language": "en",
  "steps": [{
    "idx": 1, "title": "Code the invoice to a cost center",
    "screen_moment": {"t_ms": 5000, "keyframe_path": null, "description": "Invoice 4471, cost center field"},
    "decision": {"type": "judgment", "summary": "Re-coded from opex 4711 to capex 0400"},
    "reason": {"text": "Equipment over 5000 is capex", "quote": "Equipment over five thousand is always capex", "t_ms": 6000},
    "guardrails": [{"id": "g1", "type": "stop_and_ask", "rule": "No asset number: stop and ask the controller",
                    "quote": "I never book capex, I stop and ask the controller", "t_ms": 8000, "source": "expert"}],
    "predict_prompt": "A 7,200 EUR compressor arrives. Which code?"
  }],
  "global_guardrails": [],
  "teachback": {"confirmed": true, "corrections": ["Hold applies to every supplier who double-bills in December"]}
}
```

Every `quote` is checked by the backend: it must be a verbatim span of one expert line in the transcript, and its `t_ms` is taken from that line. A skill whose quotes fail the check is never saved.

Types for the new endpoints:

```ts
export type QuestionCandidate = { id: string; type: "reason" | "guardrail" | "limit" | "exception"; text: string; anchor_event_id: number; priority: number };
export type StepDraft = { idx: number; title: string; t_start_ms: number | null; t_end_ms: number | null; event_ids: number[]; question_ids: string[]; status: "open" | "closed" };
export type Gap = { id: string; type: "missing_reason" | "missing_guardrail" | "unasked_question" | "unclear_term" | "unseen_case"; text: string; step_idx: number | null; anchor_event_id: number | null; priority: number };
export type Guardrail = { id: string; type: "limit" | "exception" | "stop_and_ask"; rule: string; quote: string; t_ms: number | null; source: "expert" | "teachback" };
export type SkillStep = {
  idx: number; title: string;
  screen_moment: { t_ms: number; keyframe_path: string | null; description: string };
  decision: { type: "judgment" | "routine"; summary: string };
  reason: { text: string; quote: string; t_ms: number } | null;
  guardrails: Guardrail[]; predict_prompt: string | null;
};
export type SkillJson = {
  id: string; title: string; description: string; author: { id: string; name: string }; created_at: string; language: string;
  steps: SkillStep[]; global_guardrails: Guardrail[]; teachback: { confirmed: boolean; corrections: string[] };
};
export type SkillSummary = {
  id: string; title: string; description: string; domain: string | null; language: string; status: "draft" | "published";
  author: { id: string; name: string }; steps_count: number; guardrails_count: number; created_at: string; published_at: string | null;
};
export type SkillDetail = SkillSummary & { skill: SkillJson | null; skill_md: string | null };
```

To build UI before the backend is wired in, mock these with the examples above (the same shapes are returned in every `AUTH_MODE`).

## 4. Rules for the browser

1. **Send frames straight to the backend**, not through a Next.js API route (Vercel limits bodies to 4.5 MB and adds latency).
2. **Frame gate.** Only send a frame when the screen changed (compare a 32x32 grayscale copy with the last sent one), plus a heartbeat every 5 s.
3. **One request in flight.** The backend skips a frame that arrives while the previous one is still being analysed (`skipped: "busy"`). Do the same on the client and just drop the new frame.
4. Downscale to about 1024 px wide, JPEG quality 0.6 (about 80 to 150 KB). Typical latency is 1 to 3 s, with rare outliers up to 8 s (then `skipped: "timeout"`).

## 5. Example client (TypeScript)

```ts
const API = process.env.NEXT_PUBLIC_API_URL!;

export type PadawanEvent = {
  id: number; kind: string; summary: string; salient: boolean; confidence: number;
  entities: Record<string, string>; visible_text: string[];
};
export type FrameResponse = {
  t_ms: number; screen_summary: string; events: PadawanEvent[];
  question_candidates: QuestionCandidate[]; step_update: { idx: number; title: string; status: "open" | "closed" } | null;
  latency_ms: number | null;
  skipped: "busy" | "timeout" | "vision_error" | "parse_error" | "storage_error" | "off_the_record" | null;
};

export async function createTeachSession(title: string, token?: string) {
  const r = await fetch(`${API}/v1/teach/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ title }),
  });
  if (!r.ok) throw new Error(`create session failed: ${r.status}`);
  return (await r.json()) as { session_id: string };
}

export async function sendFrame(sessionId: string, tMs: number, jpeg: Blob, token?: string) {
  const form = new FormData();
  form.append("t_ms", String(tMs));
  form.append("frame", jpeg, "frame.jpg");
  const r = await fetch(`${API}/v1/sessions/${sessionId}/frames`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!r.ok) throw new Error(`frame failed: ${r.status}`);
  return (await r.json()) as FrameResponse;
}

// Capture a frame from the shared screen video element
export function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const w = 1024, h = Math.round((video.videoHeight / video.videoWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d")!.drawImage(video, 0, 0, w, h);
  return new Promise((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.6));
}
```

## 6. Try it without the frontend

```bash
SID=$(curl -s -X POST localhost:8000/v1/teach/sessions -H 'Content-Type: application/json' \
  -d '{"title":"Process invoices"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session_id'])")

curl -s -X POST localhost:8000/v1/sessions/$SID/frames -F t_ms=1000 \
  -F "frame=@backend/tests/fixtures/frames/01_erp_cost_center_4711.jpg;type=image/jpeg"
curl -s -X POST localhost:8000/v1/sessions/$SID/frames -F t_ms=3000 \
  -F "frame=@backend/tests/fixtures/frames/02_erp_cost_center_0400.jpg;type=image/jpeg"
```

The second call should report the cost center change from 4711 to 0400.

## 7. No Nebius key yet?

The backend still starts and `/health` works, but frame calls return `skipped: "vision_error"` (and no question candidates; teach-back returns `502 synthesis_failed`). To build UI meanwhile, mock `sendFrame` in the frontend with the sample response in section 3.

## 8. Backend tests

```bash
cd backend
uv run pytest            # offline, fast (the vision model is faked)
uv run pytest -m live    # calls Nebius with a real frame, and runs a real synthesis
uv run python -m scripts.eval_question_planner --trials 5   # real model: is the planner's output sensible?
```

## 9. Skills (Holocrons): what the frontend expects

The Holocron view (`/dashboard/skills/[id]`) and the Jedi Archives (`/dashboard/skills`) use these calls from `frontend/lib/api.ts`. **Until the backend ships them, `NEXT_PUBLIC_API_MOCK=1` serves sample data** (two published skills and one draft; publishing a draft in mock mode is kept in localStorage). This is what the frontend assumes, tell us if the backend differs:

- `GET /v1/skills?status=published|draft` returns `[{id, title, description, domain, language, status, author: {id, name}, steps_count, guardrails_count, created_at, published_at}]`. `published` lists every published skill, `draft` only the caller's own.
- `GET /v1/skills/{id}` returns the skill JSON from Notion page 03 (`id, title, description, author, created_at, language, steps[], global_guardrails[], teachback`) plus `status, domain, steps_count, guardrails_count, published_at`.
- `POST /v1/skills/{id}/publish` (author only) returns the same detail with `status: "published"`.
- `GET /v1/skills/{id}/export` returns the rendered SKILL.md as plain text.
- Keyframe images are not shown yet (private storage with signed URLs): a step shows the timestamp and the `screen_moment.description`.
- "Start learning" links to `/dashboard/learn/{id}`, which is not built yet.

Optional backend settings for the question planner and synthesizer (all have defaults): `NEBIUS_TEXT_MODEL` (empty = same as `NEBIUS_VLM_MODEL`), `PLANNER_TIMEOUT_S` (5), `SYNTHESIS_TIMEOUT_S` (60), `SEGMENTER_EVERY_EVENTS` (10), `SEGMENTER_EVERY_S` (20).
