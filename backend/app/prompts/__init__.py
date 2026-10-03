"""Prompt files live next to this module as `<name>.system.md`. Edit them there, not in code."""

from functools import lru_cache
from pathlib import Path

_DIR = Path(__file__).parent


@lru_cache(maxsize=None)
def load_prompt(name: str) -> str:
    """Return the text of `<name>.system.md`."""
    return (_DIR / f"{name}.system.md").read_text(encoding="utf-8").strip()
