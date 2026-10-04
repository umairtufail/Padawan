import pytest

from app.main import app
from app.routers.sessions import get_planner
from app.services import gaps, segmenter


@pytest.fixture(autouse=True)
def _isolate_pipeline_state():
    """No real model for the question planner in any test unless a test installs its own fake."""

    async def no_candidates(*a, **k):
        return []

    app.dependency_overrides[get_planner] = lambda: no_candidates
    segmenter.reset_state()
    gaps.reset_state()
    yield
    app.dependency_overrides.pop(get_planner, None)
