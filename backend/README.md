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
- `POST /v1/auth/login` demo login. `GET /v1/sessions` and `GET /v1/sessions/{id}` list and read sessions.
- `POST /v1/teach/sessions` creates a session (in memory in `dev` mode, in Postgres in `supabase` mode).
- `POST /v1/sessions/{id}/frames` sends one screen frame (multipart `t_ms` + `frame` JPEG) and returns structured events.

Frontend guide with examples, rules and curl commands: [`docs/frontend-integration.md`](../docs/frontend-integration.md).
Vision prompts live in `app/prompts/`; manual model tests: `uv run python -m scripts.test_vision` and `uv run python -m scripts.eval_vision`.

## Evaluate a real screen recording (ticket #39)
```bash
cd backend
uv run python -m scripts.eval_recording path/to/recording.mp4                 # mp4, mov or webm (needs ffmpeg)
uv run python -m scripts.eval_recording path/to/frames/ --interval-ms 1000     # or a folder of frames
uv run python -m scripts.eval_recording rec.mp4 --expect expectations.json --trials 3
```
It samples frames (4 per second for video), keeps the ones the frontend's change detector would send (a Python port of `frontend/lib/frame-diff.ts`, same thresholds; `--gate none` keeps everything, the default for a folder), runs each kept frame through the real vision service with the previous redacted summary threaded like `POST /sessions/{id}/frames`, and writes `eval_out/<name>_<time>.md` and `.json` (gitignored): timeline with timestamps, events, summaries, latency, why frames were skipped, and counters (frames kept vs total, events per frame, salient ratio, parse errors). It needs `NEBIUS_API_KEY` in the repo-root `.env` and never prints it.

`expectations.json` is a list of `{"name": "...", "t_ms_range": [start, end], "must_mention": ["4711", "0400"]}`; an entry is met when all strings appear in the events of the frames kept in that range (add `"max_events": 0` for "nothing should be reported here"). The report shows recall per trial and says whether a miss came from the gate (no frame kept) or the model. A synthetic example (fake ERP form, Pillow-drawn) lives in `tests/fixtures/recording_synth/`; regenerate it with `uv run python -m scripts.make_synth_recording`. It only exercises the tool; it says little about real screens. Not modelled: the endpoint's "one call in flight" skipping (frames here are analysed one after another).

## Auth and storage modes
`AUTH_MODE=dev` (default): no login, in-memory sessions. `AUTH_MODE=admin`: one hardcoded demo account (`ADMIN_USER` / `ADMIN_PASSWORD`, default `admin` / `admin`), `POST /v1/auth/login` returns a token signed with `ADMIN_JWT_SECRET`, sessions in memory (set a strong password and secret on any public deployment). `AUTH_MODE=supabase`: the Bearer token is a Supabase access token, verified against the project's public keys (`SUPABASE_JWKS_URL`), and data is stored in Postgres by calling Supabase **as the user** (their token plus `SUPABASE_PUBLISHABLE_KEY`), so row-level security enforces ownership. No service-role key is used. Code: `app/auth.py` and `app/repo.py`. Tests: `uv run pytest` (61 offline tests, including token checks with a self-signed key and mocked Supabase calls).
