from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Reads the repo-root .env (and real environment variables on FastAPI Cloud).
    model_config = SettingsConfigDict(env_file="../.env", extra="ignore")

    elevenlabs_api_key: str = ""
    elevenlabs_interviewer_agent_id: str = ""
    elevenlabs_tutor_agent_id: str = ""

    nebius_api_key: str = ""
    nebius_base_url: str = "https://api.tokenfactory.us-north1.nebius.com/v1/"
    nebius_vlm_model: str = "deepseek-ai/DeepSeek-V4.1-Flash"

    # Skip a frame if the vision model takes longer than this (shared endpoint has slow outliers).
    vision_timeout_s: float = 8.0

    # Text model for the question planner and the skill synthesizer. Empty = same model as the vision one.
    nebius_text_model: str = ""
    # The planner runs inline on salient frames, so it gets a short budget; failure means no candidates.
    planner_timeout_s: float = 5.0
    # Synthesis is one big call (plus one retry) and runs when the author confirms the teach-back.
    synthesis_timeout_s: float = 60.0
    # Run the step segmenter after this many new events, or this many seconds, whichever comes first.
    segmenter_every_events: int = 10
    segmenter_every_s: float = 20.0

    # Default is "admin" so a deployment that forgets to set AUTH_MODE is closed, not open.
    # "dev": no login needed, in-memory sessions (local UI work only, never deploy this).
    # "admin": one hardcoded demo account (ADMIN_USER / ADMIN_PASSWORD), token issued by this backend, in-memory sessions.
    # "supabase": real Supabase login + Supabase storage.
    auth_mode: Literal["dev", "admin", "supabase"] = "admin"

    # Demo account for AUTH_MODE=admin (and for the login page in dev mode). Override both on any public deployment.
    admin_user: str = "admin"
    admin_password: str = "admin"
    # Signs the admin tokens. Empty = a random secret per process (logins reset on restart or on another instance).
    admin_jwt_secret: str = ""
    admin_token_ttl_s: int = 43200

    supabase_url: str = ""
    supabase_publishable_key: str = ""
    supabase_service_role_key: str = ""
    supabase_jwks_url: str = ""

    allowed_origins: str = "http://localhost:3000"


settings = Settings()


def text_model() -> str:
    return settings.nebius_text_model or settings.nebius_vlm_model


def security_warnings(cfg: Settings) -> list[str]:
    """Things that make a deployment unsafe. Logged loudly at startup."""
    out = []
    if cfg.auth_mode == "dev":
        out.append("AUTH_MODE=dev: the API needs NO login. Fine locally, never on a public deployment.")
    if cfg.auth_mode == "admin":
        if cfg.admin_password == "admin":
            out.append("ADMIN_PASSWORD is still the default 'admin': anyone can log in. Set your own.")
        if not cfg.admin_jwt_secret:
            out.append("ADMIN_JWT_SECRET is empty: a random secret is used, logins reset on restart or on another instance.")
    return out
