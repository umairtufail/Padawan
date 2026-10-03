# Frontend integration guide (backend v0: sessions and frames)

How to run the backend locally and call it from the Next.js app. Everything here was tested end to end.

## 1. Run the backend

You need [uv](https://docs.astral.sh/uv/) and the repo-root `.env` (ask the team for the Nebius key through the password manager, never in chat or git).

```bash
cp .env.example .env            # first time only, then fill NEBIUS_API_KEY
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

**Auth is a dev stub for now.** No token is needed; every request is the same dev user. Real Supabase JWT checking comes later, so already send `Authorization: Bearer <supabase access token>` if you have one. It is ignored today.

**Sessions live in memory.** Restarting the backend forgets them (you will get a 404 on the next frame, just create a new session).

## 3. The two endpoints

### Create a teach session
`POST /v1/teach/sessions` with JSON `{"title": "...", "description": "", "language": "en"}`, returns `201`:

```json
{"session_id": "0b3cc50a-...", "title": "Process supplier invoices", "description": "", "language": "en", "created_at": "2026-10-03T21:00:00Z"}
```

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
- **`skipped`** is `null` when the frame was analysed. Otherwise it is one of `busy`, `timeout`, `vision_error`, `parse_error`. Just carry on with the next frame, nothing to retry and nothing to show the user.
- Errors: `404` unknown session, `400` empty frame, `413` frame over 4 MB.

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
  skipped: "busy" | "timeout" | "vision_error" | "parse_error" | null;
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
