"""Health check endpoint."""

from fastapi import APIRouter

from app import __version__
from app.api.deps import SettingsDep

router = APIRouter(tags=["health"])


@router.get("/health")
async def read_health(settings: SettingsDep) -> dict:
    return {
        "status": "ok",
        "service": settings.project_name,
        "version": __version__,
    }
