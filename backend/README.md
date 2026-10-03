# Backend (FastAPI, deployed on FastAPI Cloud)

```bash
cd backend
uv sync                           # creates .venv from pyproject.toml / uv.lock
uv run fastapi dev app/main.py    # http://localhost:8000/docs
uv run pytest                     # tests live in backend/tests
uv run ruff check .               # lint
uv add <package>                  # add a dependency (updates pyproject.toml and uv.lock)
```

Layout: `app/routers` (HTTP), `app/services` (vision, segmenter, question planner, synthesizer, guardrail checker, privacy, elevenlabs), `tests`.
Config comes from the repo-root `.env` (see `../.env.example`).

## API (v0)
- `POST /v1/teach/sessions` creates a session (in memory in `dev` mode, in Postgres in `supabase` mode).
- `POST /v1/sessions/{id}/frames` sends one screen frame (multipart `t_ms` + `frame` JPEG) and returns structured events.

Frontend guide with examples, rules and curl commands: [`docs/frontend-integration.md`](../docs/frontend-integration.md).
Vision prompts live in `app/prompts/`; manual model tests: `uv run python -m scripts.test_vision` and `uv run python -m scripts.eval_vision`.

## Auth and storage modes
`AUTH_MODE=dev` (default): no login, in-memory sessions. `AUTH_MODE=supabase`: the Bearer token is a Supabase access token, verified against the project's public keys (`SUPABASE_JWKS_URL`), and data is stored in Postgres by calling Supabase **as the user** (their token plus `SUPABASE_PUBLISHABLE_KEY`), so row-level security enforces ownership. No service-role key is used. Code: `app/auth.py` and `app/repo.py`. Tests: `uv run pytest` (35 offline tests, including token checks with a self-signed key and mocked Supabase calls).
