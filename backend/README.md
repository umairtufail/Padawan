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
