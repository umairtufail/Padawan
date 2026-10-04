# Padawan frontend

Next.js 16 (App Router, React 19, Tailwind 4). Yoda is the AI; the expert is the Master, the new hire the Padawan.

## Routes

| Route | Access | What |
|---|---|---|
| `/` | public | Landing page |
| `/login` | public | Sign in: demo `admin` / `admin` (checked by the backend), or email and password with Supabase when `NEXT_PUBLIC_AUTH_MODE=supabase` |
| `/dashboard` | token | Overview: Teach Yoda, status strip, My sessions |
| `/dashboard/teach` | token | Name the task and press start: the browser asks for the screen, the session is created and recording is already running on the next page |
| `/dashboard/teach/[id]` | token | Live session: recorder, what Yoda sees now, the frame timeline, all events (polled every 3 s) |
| `/dashboard/capture` | token | The screen recorder on its own (snapshots stay in the browser, nothing is sent) |

The guard is client side (`app/dashboard/layout.tsx`): no `padawan_token` in `localStorage` means redirect to `/login`, and any 401 from the API clears it.

## How recording works

1. **Start = record.** `components/start-teaching.tsx` calls `getDisplayMedia` inside the click (browsers require a user gesture), then creates the session and hands the live stream to the session page (`lib/capture-handoff.ts`). The page opens already recording. The mouse cursor is left out of the stream (`cursor: "never"` where the browser supports it).
2. **Change detection** (`lib/frame-diff.ts`, tests in `lib/frame-diff.test.ts`, run `npm test`). A few times a second the recorder compares a small copy of the screen with the last captured frame. It works on blocks, not on the whole screen, so a changed field value counts while a blinking caret or video noise does not: a block counts when enough of its pixels changed, changed blocks are grouped into clusters, and a frame is worth sending when a large area changed, a cluster of neighbouring blocks changed, several blocks changed, or one block changed strongly (and the change is bigger than a cursor). After a change it waits for the screen to settle, so Yoda sees the finished state and not the animation, but never longer than a few seconds. The very first frame is always taken.
3. **Buffer and timeline** (`lib/use-frame-buffer.ts`, `components/frame-timeline.tsx`). Captured frames wait in a buffer (at most 6, the oldest are dropped), are sent one at a time in order, and each keeps the moment it was taken (clock time and time since the start), the changed region (boxed on the thumbnail), its status (waiting, analysing, analysed, skipped, failed) and what the model said about it. The first look is retried automatically if the model is slow.

The settings (changed area, pixel tolerance, detect small edits, comparison rate) are in the recorder's "Detection settings".

## Environment

Copy `.env.example` to `.env.local`.

- `NEXT_PUBLIC_API_URL` backend base URL (default `http://localhost:8000`)
- `NEXT_PUBLIC_API_MOCK=1` fake data, no backend needed
- `NEXT_PUBLIC_AUTH_MODE` `admin` (default: the backend's demo account) or `supabase` (real accounts, email and password, see `../docs/supabase-login.md`). Needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public values) and a backend running with `AUTH_MODE=supabase`.

## Run

```bash
npm install
npm run dev                          # real backend on :8000
NEXT_PUBLIC_API_MOCK=1 npm run dev   # mock mode
npm run lint && npm test && npm run build
```

All API calls live in `lib/api.ts`.
