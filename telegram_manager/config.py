"""Environment-only configuration; never commit tokens."""
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    manager_bot_token: str = Field(min_length=20)
    storage_key: str = Field(min_length=32, description="Fernet key for child tokens")
    database_path: Path = Path("data/managed_bots.sqlite3")
    poll_timeout_seconds: int = Field(default=30, ge=1, le=50)
    model_config = SettingsConfigDict(env_file="telegram_manager/.env", env_prefix="TG_MANAGER_", extra="ignore")
