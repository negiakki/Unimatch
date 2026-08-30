"""Route modules aggregated into a single v1 API router."""

from fastapi import APIRouter

from app.api.routes import (
    admin,
    discovery,
    health,
    interests,
    matches,
    photos,
    profiles,
    universities,
    verification,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(profiles.router)
api_router.include_router(photos.router)
api_router.include_router(universities.router)
api_router.include_router(interests.router)
api_router.include_router(verification.router)
api_router.include_router(admin.router)
api_router.include_router(discovery.router)
api_router.include_router(matches.router)
