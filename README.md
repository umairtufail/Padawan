# Padawan

Teach Yoda what you know. A voice agent (Yoda) watches an expert's screen, asks why at the right pause, turns the session into a Holocron (skill), and later tutors the next Padawan.

```
frontend/   Next.js (App Router) on Vercel: dashboard, Meet-style session UI
backend/    FastAPI on FastAPI Cloud: frames, events, steps, skill synthesis, guardrail checks
            backend/tests  pytest
supabase/   SQL migrations
packages/   shared schemas (skill, event, OpenAPI)
docs/       short notes (full docs in Notion)
```

## Run it

```bash
cp .env.example .env            # then fill in keys (never commit .env)
# backend
cd backend && python -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt && fastapi dev app/main.py
# frontend (new terminal)
cd frontend && cp .env.example .env.local && npm install && npm run dev
```

## Conventions
- Branch per task, small PRs into `main`. Protect `main`.
- Frames go browser to the backend directly, never through Next.js API routes (Vercel 4.5 MB body limit).
- No secrets in the frontend. Only `NEXT_PUBLIC_*` values.
- Tests: backend in `backend/tests` (pytest), frontend next to the code.
