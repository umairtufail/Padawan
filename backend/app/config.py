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

    # "dev": no login needed, in-memory sessions (local UI work).
    # "admin": one hardcoded demo account (ADMIN_USER / ADMIN_PASSWORD), token issued by this backend, in-memory sessions.
    # "supabase": real Supabase login + Supabase storage.
    auth_mode: Literal["dev", "admin", "supabase"] = "dev"

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
