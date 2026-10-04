# AGENTS.md

Rules for everyone working in this repo, people and AI coding agents alike. Short on purpose. The product overview is in `README.md`, the full design is in Notion (**Padawan - Hack-nation 07**).

## The product in one paragraph
Padawan watches an expert's shared screen, asks "why" at natural pauses with a voice agent (Yoda), and turns the session into a Holocron (skill: steps, reasons, guardrails). Later Yoda tutors a new hire (the Padawan) and stops them before they break a guardrail. It is an *apprentice*, not a recorder: capturing the reason and the limits matters more than capturing clicks.

## Where things live
- `backend/app/routers/` HTTP endpoints. `backend/app/services/` model calls and logic. `backend/app/prompts/*.system.md` **the prompts: edit them there, not in code.**
- `backend/app/auth.py` who is calling. `backend/app/repo.py` where data lives (memory in dev, Supabase otherwise).
- `supabase/migrations/` the exact SQL applied to the database. `frontend/` Next.js app. `docs/` guides.
- Tickets are GitHub issues (#22 to #45 cover what is left to build; labels give the area, priority `P0` to `P2`, type, and `blocked` when it waits for another ticket). Pick one, assign yourself or comment that you took it. Start with the `P0 demo-critical` ones.

## Commands
```bash
cd backend && uv sync && uv run fastapi dev app/main.py        # API on :8000
cd backend && uv run pytest                                     # must pass before every PR
cd backend && uv run ruff check .                               # lint
cd frontend && npm install && npm run dev                       # app on :3000
cd frontend && npm run lint && npm test && npm run build        # must pass before every PR
```
Backend dependencies are managed with **uv** (`uv add <pkg>`), never `pip install` or a `requirements.txt`.

## Hard rules
1. **Secrets: one deliberate exception.** The root `.env` is committed on purpose for the hackathon so the team can just pull it. This is only acceptable because the repo is **private** and has just the four team members. Therefore: **never make the repo public** while `.env` is in it, never commit `frontend/.env.local`, never add any other secret or personal key anywhere, and only commit `.env` changes the whole team needs (it is tracked, so your local edits show up as changes). **After the hackathon:** rotate the Nebius and ElevenLabs keys and run `git rm --cached .env` (then rewrite history if the repo will ever be shared).
2. **The frontend only gets public values** (`NEXT_PUBLIC_*`). Never the service-role key or any API secret.
3. **Frames go from the browser straight to the backend**, never through a Next.js API route (Vercel's 4.5 MB body limit).
4. **Never trust a user id sent by the client.** The backend takes it from the verified token (`app/auth.py`). Data access runs as the user, so row-level security protects it. Every new table needs RLS enabled and policies written for who may read and write it.
5. **Do not break the contracts** without telling the team in the PR: the frames response shape (`app/schemas.py`, `docs/frontend-integration.md`), the event schema, the skill JSON (Notion page 03), the database schema.
6. **Schema changes are new migration files** in `supabase/migrations/` (never edit an applied one), applied to the project, then run the Supabase security advisor.
7. **Be honest in docs and the pitch.** Say what is built and what is mocked. Do not claim results we have not measured.

## Backend notes that save time
- The vision call sends the **previous frame's `screen_summary`** along with the new frame. The summary must contain the current values of the key fields (for example "cost center 4711, asset no. empty"), because the next comparison depends on it.
- A slow, failed or unparseable model call must never break the stream: return `skipped` and carry on. One vision call in flight per session; extra frames are skipped, not queued.
- **Changing a prompt?** Run `uv run python -m scripts.eval_vision --trials 5` before and after, and paste both results in the PR. Model speed and quality on the shared Nebius endpoint vary a lot between calls.
- Default vision model: `deepseek-ai/DeepSeek-V4.1-Flash` (`NEBIUS_VLM_MODEL`). `zai-org/GLM-5.3-Flash` is the fallback and needs thinking turned off (already handled in `services/vision.py`).
- **Never deploy with `AUTH_MODE=dev`** (no login). The default is `admin`; on any public deployment also set a non-default `ADMIN_PASSWORD` and a fixed `ADMIN_JWT_SECRET` (see `docs/deployment.md`). The backend logs `SECURITY:` warnings at startup for risky settings.
- Tests must not call external services unless marked `live`. Fake the model and Supabase (see `tests/`).

## Frontend notes
- `frontend/AGENTS.md` applies there: this is a recent Next.js with breaking changes. Read the guides in `frontend/node_modules/next/dist/docs/` before writing code.
- Call the backend through one typed client (see `docs/frontend-integration.md`), send `Authorization: Bearer <access_token>` (get it with `supabase.auth.getSession()` right before each call), and treat `skipped` in a frame response as normal.
- Branding: Star Wars themed, **Yoda is the AI**. The expert is "the Master", the new hire "the Padawan", a skill "a Holocron", the marketplace "the Jedi Archives". Use names and our own styling only. **No official logos, film stills, character art, music or the real voice** (trademarks).

## Working with git
- One branch per task (`feature/<short-name>`), small pull requests into `main`. No force-push to shared branches. Do not push straight to `main` once it is protected.
- Commit messages: say what and why in the first line, details below. AI-assisted commits keep their `Co-Authored-By` trailer.
- Before opening a PR: tests and lint pass, no secrets staged, docs updated if you changed an endpoint, a command or a variable.
- Touching the same files as someone else? Say so in the issue first. Shared hot spots: `backend/app/main.py`, `backend/app/schemas.py`, `frontend/app/layout.tsx`, `supabase/migrations/`.

## Working in parallel (people and agents)
Split independent tasks (different files, no shared state) across people or subagents and do them at the same time; keep tasks that depend on each other in sequence. When an agent finishes a piece of work, it should say what it changed, what it verified and what it did not.

## Definition of done
- It works end to end, not only in a unit test (run it, call it, look at the result).
- Tests added or updated, all green. Lint and build pass.
- No secrets, no leftover test data in Supabase (clean up users and rows you create for testing).
- The ticket is updated with what is done and what is left.

## When unsure
Ask in the ticket or ask the team. A short question beats a wrong guess, especially for anything that touches auth, data access or the contracts above.
