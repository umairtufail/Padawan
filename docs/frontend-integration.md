# Frontend integration guide (backend v0: sessions and frames)

How to run the backend locally and call it from the Next.js app. Everything here was tested end to end.

## 1. Run the backend

You need [uv](https://docs.astral.sh/uv/). Copy the team keys from the Notion page "Keys and environment values" into a repo-root `.env` (gitignored).

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
- `GET /v1/sessions` returns the caller's sessions, newest first: `[{"session_id", "title", "created_at", "last_screen_summary", "events_count", "status", "skill_id"}]` (`status`: `live`, `debrief`, `processing`, `done`, `failed`; `skill_id` is set once the Holocron exists).
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

- `capture` and `debrief` use the interviewer agent (`mode` is `live` or `debrief`), `tutor` uses the tutor agent (variables `task_title`, `skill_md`, `expert`, and for a learn session `skill_steps`, `skill_guardrails`, `current_step`, `current_step_idx`, see section 10). `gaps` (debrief) is a placeholder until it is wired to the planner.
- Start the conversation in the browser with the ElevenLabs SDK, passing the `signed_url` and the `dynamic_variables` (for the JS SDK: `Conversation.startSession({ signedUrl, dynamicVariables })`). The browser never sees the API key. The signed URL is short lived: ask for a new one per conversation.
- **The interviewer is silent until you send it a user message starting with `[ASK]`**, for example `[ASK] Why did you change the cost center from 4711 to 0400?`. It then asks that question aloud, in one sentence, and stops. In debrief mode, send `[START]` to make it begin. The tutor greets first and reacts to `[INTERVENE]`.
- Client tools the agents may call (implement them in the page): interviewer `log_answer(question_id, summary)`, `set_off_record(on)`, `submit_teachback(confirmed, corrections)`; tutor `record_prediction(step_idx, predicted)` (return a string saying whether it was right), `show_replay(step_idx)`, `finish_learning()`.
- Errors: `401` bad token, `404` unknown or someone else's session, `422` bad `mode`, `502` ElevenLabs unavailable or voice not configured.
- **Built in the frontend (#28):** `lib/use-agent-conversation.ts` (uses `@elevenlabs/client`, pinned), `lib/pause-controller.ts` (pure rules: screen idle 2 s, expert silent 1.5 s, Yoda quiet, 60 s between questions, 5 per 10 min, a question waiting) and `lib/use-pause-controller.ts` (queue, "why now" trace). Questions come from `question_candidates`; until the planner (#27) lands, a stub makes "why" questions from salient events. With `NEXT_PUBLIC_API_MOCK=1` the voice is scripted (no ElevenLabs, no microphone).
- Agents are created and updated by `cd backend && uv run python -m scripts.setup_voice_agents` (prompts live in `backend/app/prompts/interviewer.system.md` and `tutor.system.md`; re-run the script after editing them). Agent ids are in `.env` as `ELEVENLABS_INTERVIEWER_AGENT_ID` and `ELEVENLABS_TUTOR_AGENT_ID`.

### Test voice readiness
`POST /v1/voice/readiness` needs a valid login token but does not create or require a teaching session. It returns the same `signed_url`, `agent_id` and `dynamic_variables` shape as `/v1/voice/sessions`, using the interviewer agent with harmless placeholder context. The dashboard preflight first measures microphone signal locally for three seconds (audio is not recorded or uploaded), then connects with this signed URL while muted and sends `[READINESS]`. The agent says only “Ready, Yoda is.” and the client closes the conversation after playback. A `502` means the voice service is missing or unavailable, just like the session endpoint.

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
| `POST /v1/sessions/{id}/teachback` | `{"confirmed": true, "corrections": ["Hold applies to every supplier who double-bills in December"]}` | `{"skill_id", "status": "draft", "steps_count": 4, "guardrails_count": 3, "attempts": 1, "title": "Re-code supplier invoices to the right cost center", "description": "...", "summary": "..."}` |

Notes:
- **Gap `type`**: `missing_reason`, `missing_guardrail`, `unasked_question`, `unclear_term`, `unseen_case`. Sorted by `priority`, at most 12. `unasked_question` gaps come from planner candidates kept in the backend's memory, so they are lost if the backend restarts mid-session.
- **The model names the Holocron.** `title` is a specific 3 to 8 word name of the task in the session language (the prompt forbids placeholders; if the model returns "New task", "Untitled" or a whole sentence, the title falls back to the session title when that is a real name, else to the first steps). `description` is 1 to 2 sentences, `summary` one paragraph (what the Master showed and why; older skills have none, so treat it as optional). When the session title was still a placeholder, the session row is renamed to the skill title, so `GET /v1/sessions` lists a real name; it also has `status` and `skill_id` now.
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
| `GET /v1/skills?q=&domain=&mine=&sort=` | Published skills: `[SkillSummary]`. `q` searches title and description, `domain` is an exact match, `mine=true` lists **your own** skills instead (drafts included). `sort=newest` (default), `popular` (most `learners_count` first, ties newest first) or `mastery` (highest `avg_mastery` first, skills without one last); anything else is `422`. Max 100 (sorting applies to those 100) |
| `GET /v1/skills/{id}` | `SkillDetail` = `SkillSummary` plus `skill` (the Holocron JSON below, or `null`) and `skill_md`. `404` for an unknown skill or someone else's **draft** |
| `POST /v1/skills/{id}/publish` | The updated `SkillDetail`. Author only: `403` if it is visible but not yours, `404` for someone else's draft, `409` if it has no steps yet. Publishing twice changes nothing |
| `POST /v1/skills/{id}/unpublish` | The updated `SkillDetail` with `status: "draft"` and `published_at: null`. Author only: `403` if it is visible but not yours, `404` if not visible to you. Unpublishing a draft changes nothing. The skill leaves the Archives, but learn sessions that were already started keep working for their owners (they can still read the skill and finish); nobody can start a **new** learn session on it except the author |
| `GET /v1/skills/{id}/export` | The `SKILL.md` as `text/markdown` with `Content-Disposition: attachment; filename="<slug>.SKILL.md"`. Readable for published skills and your own drafts |

```json
// SkillSummary
{"id": "uuid", "title": "Process supplier invoices", "description": "...", "domain": "finance", "language": "en",
 "status": "published", "author": {"id": "uuid", "name": "Sabine"}, "steps_count": 4, "guardrails_count": 3,
 "created_at": "2026-10-03T18:00:00Z", "published_at": "2026-10-04T08:00:00Z",
 "learners_count": 3, "avg_mastery": 72.5}
```

`learners_count` is the number of **distinct people** who started a learn session on the skill (one person with five sessions counts once). `avg_mastery` is the average `mastery_score` (0 to 100, one decimal) over **finished** learn sessions, `null` while there is none. These are aggregates only: an author never sees who learned their skill, and a learner only ever sees their own sessions. The numbers are computed in the database by a narrow function (see `supabase/migrations/20261004150000_marketplace_stats.sql`), because row-level security hides other people's sessions. The same fields are on `SkillDetail`.

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
  id: string; title: string; description: string; summary?: string; author: { id: string; name: string }; created_at: string; language: string;
  steps: SkillStep[]; global_guardrails: Guardrail[]; teachback: { confirmed: boolean; corrections: string[] };
};
export type SkillSummary = {
  id: string; title: string; description: string; domain: string | null; language: string; status: "draft" | "published";
  author: { id: string; name: string }; steps_count: number; guardrails_count: number; created_at: string; published_at: string | null;
  learners_count: number; avg_mastery: number | null; // aggregates, never who
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

## 9. What the frontend does with these endpoints

The contract in sections 3 and 3b is what `frontend/lib/api.ts` implements (no assumptions left). With `NEXT_PUBLIC_API_MOCK=1` every call is mocked (including a scripted Yoda, no ElevenLabs and no microphone), so the whole flow runs without a backend.

- **Live session** (`/dashboard/teach/[id]`): transcript lines go to `utterances` in batches every 4 s (expert lines are skipped while off the record); when the pause controller sends a question, the page calls `questions/{qid}/asked` with the "why now" trace (the candidate `id` is used when it is a UUID, stub and manual questions get a client UUID); `log_answer` calls `answers` with the expert's transcribed words as `quote`. `question_candidates` feed the pause controller; the stub question source only runs when a frame brings none. Steps come from `GET steps` every 4 s and at once when `step_update` changes.
- **Finish session** calls `finish`, keeps the result in `sessionStorage`, and opens `/dashboard/teach/[id]/debrief`.
- **Debrief**: the voice session (`mode=debrief`) starts by itself, Yoda asks the gaps aloud and explains the process back, and `submit_teachback` (or the mock "yes, exactly" button) calls `teachback`, then the debrief shows the name, description and summary Yoda wrote for a few seconds and opens the new draft at `/dashboard/skills/[id]`, which has the Publish button. Typed answers are an accessibility fallback (no microphone, or the connection failed). At least 3 gap answers (or all, if fewer) are required before the teach-back.
- **Archives** use `GET /v1/skills` (published) and `?mine=true` ("My Holocrons", drafts included). A `SkillDetail` has the skill JSON under `skill` (can be `null`); `reason` can be `null`, guardrails have `source`.
- **Marketplace** (Archives): the grid passes `sort=newest|popular|mastery`; the domain chips come from the loaded list and filter client-side. Cards and the Holocron page show `learners_count` and `avg_mastery` (hidden when 0 or null; scale assumed 0 to 100). The author sees "Unpublish" (`POST /v1/skills/{id}/unpublish`) on a published skill; ownership is detected by the id being in `GET /v1/skills?mine=true`. **My learning** (`/dashboard/learning`) uses `GET /v1/learn/sessions`; finished rows open `/dashboard/learning/{session_id}`, which renders `GET /v1/learn/sessions/{id}/report`. A lesson cannot be resumed (the lesson page always creates a new session), so unfinished rows say "Start the lesson again". `skill_id` can be `null` in that list (skill deleted).
- Keyframe images are not shown yet: a step shows the timestamp and `screen_moment.description`. "Start learning" links to `/dashboard/learn/{id}` (see section 10, "The learn page").

Optional backend settings for the question planner and synthesizer (all have defaults): `NEBIUS_TEXT_MODEL` (empty = same as `NEBIUS_VLM_MODEL`; one model for the planner and the synthesizer; measured on our samples: DeepSeek V4.1 Flash, V4 Pro and GLM-5.3 all gave good English titles in 2 to 4 s, but only GLM-5.3 kept to the draft steps on a German sample, so it is the one to try for synthesis, the default is unchanged because the planner has not been measured with it), `PLANNER_TIMEOUT_S` (5), `SYNTHESIS_TIMEOUT_S` (60), `SEGMENTER_EVERY_EVENTS` (10), `SEGMENTER_EVERY_S` (20).

## 10. Learn mode (the Padawan works through a Holocron, Yoda tutors)

All calls need the same token as above. A **learn session** is a session of kind `learn` that points at a skill. It has its own endpoints under `/v1/learn`; the teach endpoints (`/v1/sessions/{id}/finish`, `/teachback`, ...) and `GET /v1/sessions` do **not** see learn sessions (`404` / not listed). Learn sessions are private to the learner (`404` for anyone else). Any **published** skill can be learned by any signed-in user; the author can also learn their own draft.

| Method and path | Body | Response |
|---|---|---|
| `GET /v1/learn/sessions` | none | `[LearnSessionListItem]`, **your own** learn sessions, newest first (max 100). See below |
| `POST /v1/learn/sessions` | `{"skill_id": "uuid"}` | `201 LearnSessionOut`. `404` unknown skill or someone else's draft, `409` skill has no steps |
| `POST /v1/learn/sessions/{id}/frames` | multipart `t_ms` + `frame` (JPEG), same as teach frames | `LearnFrameResponse` (frame response plus `verdict`) |
| `POST /v1/learn/sessions/{id}/predictions` | `{"step_idx": 1, "predicted": "cost center 0400", "resolve": false}` | `PredictionOut`. `422` unknown `step_idx` or empty text |
| `POST /v1/learn/sessions/{id}/predictions/{step_idx}/resolve` | none | `PredictionResult`. `409` if no prediction was recorded for that step |
| `GET /v1/learn/sessions/{id}/report?summary=true` | none | `MasteryReport`. Any time, repeatedly, does not end the session. `summary=false` skips the model call (instant) |
| `POST /v1/learn/sessions/{id}/finish` | none | `MasteryReport` (with summary), and the session is marked `done` |

`GET /v1/learn/sessions` (the learner's history) returns, newest first, only the caller's own sessions:

```ts
export type LearnSessionListItem = {
  session_id: string; skill_id: string | null; skill_title: string; created_at: string;
  finished: boolean;            // true after POST .../finish
  mastery_score: number | null; // 0..100, set only when finished
  steps_total: number;          // steps in the Holocron
  steps_done: number;           // steps with any progress (reached or predicted), never above steps_total
};
```
`finish` stores the final `mastery_score`, which is what feeds the skill's `avg_mastery`. A learn session keeps working after the author unpublishes the skill (the skill stays readable to people who already started it), and it stays in the history.

Errors for all of them: `401`, `404` unknown or not your learn session, `409` the session's skill is no longer readable, `502 {"detail": "storage unavailable"}`.

### Frames and the verdict
The frame goes through the same vision pipeline as capture (events, PII redaction, `skipped` reasons, off-the-record), minus question candidates and step grouping (`question_candidates` is always `[]`, `step_update` always `null`). When events are found, a **guardrail checker** (one text-only model call, about 1 s, budget 5 s) compares the learner's pending move with the skill and the answer is in `verdict`. `verdict` is `null` only when the frame was `skipped`.

The checker is conservative: `stop` needs confidence of at least 0.8 and a real guardrail id, otherwise it is a `warn` (or `ok` below 0.5). A move that was **already saved** is never a `stop` (too late), it is a `warn` with `committed: true`. A slow, failed or garbled checker gives `ok` with `degraded: true` and never an error. It only judges what the screen shows, so it can miss a wrong move that is not visible, and it adds about 1 s on top of the vision call.

What the frontend does with it:
- `stop`: show the banner (`rule`, `expert_quote`, `reason`), send the voice agent a user message `[INTERVENE] step {step_idx}, guardrail {guardrail_id}: {rule}. {reason}`, and open `replay` when Yoda calls `show_replay` (the Master's moment: `t_ms` and `description`; `keyframe_path` is `null` for now).
- `warn`: show a gentle hint and send `[WARN] ...` (the tutor mentions it briefly and does not stop the learner).
- `repeated: true`: the same verdict was already given within the last 30 s. Keep the banner but **do not speak or count it again**.
- `checked: false`: no check ran (no new events). That `ok` is not news: do not clear a visible `stop` banner because of it. Clear the banner on the next `checked: true` verdict that is `ok`.
- `step_idx` / `step_title`: the skill step the learner is on now (use it to move the progress marker).

### Predictions
`POST .../predictions` is what the tutor tool `record_prediction(step_idx, predicted)` calls (before the step). With `"resolve": true` it also compares right away and returns the result, which is what the tool should return to Yoda (say whether it was right, then explain the reason). Without it, call `POST .../predictions/{step_idx}/resolve` after the learner did the step. Predicting again for a step replaces the earlier prediction. The comparison is against the Master's decision in the skill, judged by a model (`judged_by: "model"`) or, if the model is slow or fails, by a crude keyword match (`"heuristic"`). Predictions are most useful on `judgment` steps (`predict_prompt` is set there).

### Mastery report
Computed deterministically from stored data; only `summary` (2 to 3 sentences in Yoda's voice) is model-written and falls back to a plain sentence (`summary_source: "fallback"`). Per step, score = mean of a safety part (`1 - 0.5 per stop - 0.15 per warning`, floor 0) and, if a prediction was compared, a prediction part (1 right, 0 wrong). `result` is `mastered` at score 0.75 or more, `practise` below it, `not_reached` if the learner never got to the step. `mastery_score` (0 to 100) is the sum of the step scores over **all** steps (unreached count 0), rounded half up. `practise_next` lists steps that are not mastered, worst first, with a `why`. Time per step comes from the `t_ms` the client sends with frames; the time on the step the learner is on now is added when the report is read. Progress lives in server memory and the `learn_attempts` table; after a backend restart the time of the step that was open is lost.

### Voice: tutor variables
`POST /v1/voice/sessions` with `mode: "tutor"` and a **learn** session id now fills the tutor's variables from the skill: `skill_md` (the SKILL.md) and `expert` (the author's name), plus new `skill_steps`, `skill_guardrails`, `current_step` (for example `1. Code the invoice`) and `current_step_idx`. The original three (`task_title`, `skill_md`, `expert`) keep their meaning; for a session that is not a learn session every variable keeps a placeholder (`(no skill loaded)`, `the Master`, `(none)`, `0`). The tutor prompt uses the new variables: **re-run `uv run python -m scripts.setup_voice_agents` to push the updated prompt** to ElevenLabs.

### The learn page (`/dashboard/learn/[id]`, id = skill id)
"Begin the lesson" asks for the screen share (a user click is needed), creates the learn session, and Yoda's tutor voice starts by itself. Frames go through `useFrameBuffer(..., { send: sendLearnFrame })` to `/v1/learn/sessions/{id}/frames`. `lib/learn.ts` holds the pure logic (`applyVerdict`, the `[INTERVENE]`/`[WARN]`/`[STEP]`/`[REPORT]` messages), `lib/learn-api.ts` the calls. Yoda speaks everything (tutor prompt commands `[START]`, `[STEP]`, `[REPORT]`, `[WARN]`, `[INTERVENE]`; re-run `setup_voice_agents` after pulling); captions only show what was said. The tools run in the page: `record_prediction` (resolves at once and answers Yoda), `show_replay` (opens the Master's moment drawer), `finish_learning` (shows the report). The report is shown on the same page, not a sub-route. With `NEXT_PUBLIC_API_MOCK=1` the whole flow is scripted (verdicts ok, ok, warn, stop, all-clear, a scripted Yoda voice, a mock report).

### Types

```ts
export type Verdict = "ok" | "warn" | "stop";
export type ReplayMoment = { step_idx: number; t_ms: number; description: string; keyframe_path: string | null };
export type GuardrailVerdict = {
  verdict: Verdict; checked: boolean; step_idx: number | null; step_title: string;
  guardrail_id: string | null; rule: string; expert_quote: string; reason: string; confidence: number;
  committed: boolean; repeated: boolean; degraded: boolean; replay: ReplayMoment | null;
};
export type LearnFrameResponse = FrameResponse & { verdict: GuardrailVerdict | null };
export type LearnSessionOut = { session_id: string; skill_id: string; title: string; created_at: string; current_step_idx: number; skill: SkillJson };
export type PredictionIn = { step_idx: number; predicted: string; resolve?: boolean };
export type PredictionResult = {
  step_idx: number; predicted: string; correct: boolean; judged_by: "model" | "heuristic";
  expected: string; reason: string | null; reason_quote: string | null; replay: ReplayMoment;
};
export type PredictionOut = { step_idx: number; predicted: string; resolved: boolean; result: PredictionResult | null };
export type StepReport = {
  step_idx: number; title: string; decision_type: "judgment" | "routine"; reached: boolean;
  predicted: string | null; predicted_right: boolean | null; interventions: number; warnings: number;
  guardrail_id: string | null; time_ms: number | null; score: number; result: "mastered" | "practise" | "not_reached";
};
export type PracticeItem = { step_idx: number; title: string; why: string; guardrail_id: string | null; rule: string | null };
export type MasteryReport = {
  session_id: string; skill_id: string; skill_title: string; mastery_score: number; steps_total: number;
  steps_reached: number; steps_mastered: number; predictions_total: number; predictions_right: number;
  interventions_total: number; warnings_total: number; time_total_ms: number;
  steps: StepReport[]; practise_next: PracticeItem[]; summary: string; summary_source: "model" | "fallback" | "none";
};
```

### Mock data (build the UI before the backend is wired in)

```json
// POST /v1/learn/sessions/{id}/frames, the moment the learner types 4711 on a 7,200 EUR compressor
{"t_ms": 12000, "screen_summary": "SandboxERP invoice 4471, cost center 4711, asset no. empty", "events": [], "question_candidates": [], "step_update": null,
 "latency_ms": 1400, "skipped": null,
 "verdict": {"verdict": "stop", "checked": true, "step_idx": 1, "step_title": "Code the invoice to a cost center",
   "guardrail_id": "g2", "rule": "Equipment over 5000 EUR never goes to opex cost center 4711", "expert_quote": "never to 4711",
   "reason": "Wait. Equipment over 5,000 is capex, so 4711 is wrong here.", "confidence": 0.95, "committed": false,
   "repeated": false, "degraded": false, "replay": {"step_idx": 1, "t_ms": 5000, "description": "Cost center field", "keyframe_path": null}}}

// POST /v1/learn/sessions/{id}/predictions  {"step_idx": 1, "predicted": "capex, 0400", "resolve": true}
{"step_idx": 1, "predicted": "capex, 0400", "resolved": true,
 "result": {"step_idx": 1, "predicted": "capex, 0400", "correct": true, "judged_by": "model",
   "expected": "Equipment over 5000 EUR is capex: cost center 0400, not opex 4711", "reason": "Equipment over 5000 is capex",
   "reason_quote": "Equipment over five thousand is always capex",
   "replay": {"step_idx": 1, "t_ms": 5000, "description": "Cost center field", "keyframe_path": null}}}

// GET /v1/learn/sessions/{id}/report
{"session_id": "uuid", "skill_id": "uuid", "skill_title": "Process supplier invoices", "mastery_score": 63, "steps_total": 2,
 "steps_reached": 2, "steps_mastered": 1, "predictions_total": 2, "predictions_right": 1, "interventions_total": 1, "warnings_total": 0, "time_total_ms": 51000,
 "steps": [
   {"step_idx": 1, "title": "Code the invoice to a cost center", "decision_type": "judgment", "reached": true, "predicted": "cost center 4711",
    "predicted_right": false, "interventions": 1, "warnings": 0, "guardrail_id": "g2", "time_ms": 40000, "score": 0.25, "result": "practise"},
   {"step_idx": 2, "title": "Open the next invoice", "decision_type": "routine", "reached": true, "predicted": "open next",
    "predicted_right": true, "interventions": 0, "warnings": 0, "guardrail_id": null, "time_ms": 11000, "score": 1.0, "result": "mastered"}],
 "practise_next": [{"step_idx": 1, "title": "Code the invoice to a cost center",
   "why": "Your prediction did not match the Master's decision; Yoda had to stop you 1 time(s) on: Equipment over 5000 EUR never goes to opex cost center 4711; the Master's reason: Equipment over 5000 is capex.",
   "guardrail_id": "g2", "rule": "Equipment over 5000 EUR never goes to opex cost center 4711"}],
 "summary": "You began well, yet coding the invoice still needs practice. Practise that step again.", "summary_source": "model"}
```

Optional backend settings for learn mode (defaults in brackets): `GUARDRAIL_TIMEOUT_S` (5), `GUARDRAIL_STOP_CONFIDENCE` (0.8), `LEARN_MODEL_TIMEOUT_S` (6, for judging predictions and the summary). Measure the checker with `cd backend && uv run python -m scripts.eval_guardrail --trials 5` (real model).
