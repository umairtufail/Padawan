import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import security_warnings, settings

log = logging.getLogger("padawan")
for _w in security_warnings(settings):
    log.warning("SECURITY: %s", _w)

app = FastAPI(title="Padawan API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


from .routers import auth, sessions, voice  # noqa: E402

app.include_router(auth.router, prefix="/v1")
app.include_router(sessions.router, prefix="/v1")
app.include_router(voice.router, prefix="/v1")
# Still to come (see Notion page 04): skills, learn
