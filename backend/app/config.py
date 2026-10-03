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

    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_jwks_url: str = ""

    allowed_origins: str = "http://localhost:3000"


settings = Settings()
