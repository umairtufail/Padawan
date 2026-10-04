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
| `supabase` | Yes, a Supabase access token | Postgres (tables `sessions`, `events`) | The real flow and the demo |

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
- Agents are created and updated by `cd backend && uv run python -m scripts.setup_voice_agents` (prompts live in `backend/app/prompts/interviewer.system.md` and `tutor.system.md`; re-run the script after editing them). Agent ids are in `.env` as `ELEVENLABS_INTERVIEWER_AGENT_ID` and `ELEVENLABS_TUTOR_AGENT_ID`.

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
  question_candidates: unknown[]; step_update: unknown | null;
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

The backend still starts and `/health` works, but frame calls return `skipped: "vision_error"`. To build UI meanwhile, mock `sendFrame` in the frontend with the sample response in section 3.

## 8. Backend tests

```bash
cd backend
uv run pytest            # offline, fast (the vision model is faked)
uv run pytest -m live    # calls Nebius with a real frame
```

## 9. Skills (Holocrons): what the frontend expects

The Holocron view (`/dashboard/skills/[id]`) and the Jedi Archives (`/dashboard/skills`) use these calls from `frontend/lib/api.ts`. **Until the backend ships them, `NEXT_PUBLIC_API_MOCK=1` serves sample data** (two published skills and one draft; publishing a draft in mock mode is kept in localStorage). This is what the frontend assumes, tell us if the backend differs:

- `GET /v1/skills?status=published|draft` returns `[{id, title, description, domain, language, status, author: {id, name}, steps_count, guardrails_count, created_at, published_at}]`. `published` lists every published skill, `draft` only the caller's own.
- `GET /v1/skills/{id}` returns the skill JSON from Notion page 03 (`id, title, description, author, created_at, language, steps[], global_guardrails[], teachback`) plus `status, domain, steps_count, guardrails_count, published_at`.
- `POST /v1/skills/{id}/publish` (author only) returns the same detail with `status: "published"`.
- `GET /v1/skills/{id}/export` returns the rendered SKILL.md as plain text.
- Keyframe images are not shown yet (private storage with signed URLs): a step shows the timestamp and the `screen_moment.description`.
- "Start learning" links to `/dashboard/learn/{id}`, which is not built yet.
