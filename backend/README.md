# Backend (FastAPI, deployed on FastAPI Cloud)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
fastapi dev app/main.py          # http://localhost:8000/docs
pytest                            # tests live in backend/tests
```

Layout: `app/routers` (HTTP), `app/services` (vision, segmenter, question planner, synthesizer, guardrail checker, privacy, elevenlabs), `tests`.
Config comes from the repo-root `.env` (see `../.env.example`).
