# Padawan frontend

Next.js 16 (App Router, React 19, Tailwind 4). Yoda is the AI; the expert is the Master, the new hire the Padawan.

## Routes

| Route | Access | What |
|---|---|---|
| `/` | public | Landing page |
| `/login` | public | Sign in (demo: `admin` / `admin`, checked by the backend) |
| `/dashboard` | token | Overview: Teach Yoda, status strip, My sessions |
| `/dashboard/teach` | token | Creates a session and redirects to it |
| `/dashboard/teach/[id]` | token | Live session: screen sharing, latest summary, events (polled every 3 s) |
| `/dashboard/capture` | token | Standalone screen-capture tool (frames only logged to the console) |

The guard is client side (`app/dashboard/layout.tsx`): no `padawan_token` in `localStorage` means redirect to `/login`, and any 401 from the API clears it.

## Environment

Copy `.env.example` to `.env.local`.

- `NEXT_PUBLIC_API_URL` backend base URL (default `http://localhost:8000`)
- `NEXT_PUBLIC_API_MOCK=1` fake data, no backend needed

## Run

```bash
npm install
npm run dev                          # real backend on :8000
NEXT_PUBLIC_API_MOCK=1 npm run dev   # mock mode
npm run lint && npm run build
```

All API calls live in `lib/api.ts`.
