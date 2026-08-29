"""Route modules aggregated into a single v1 API router."""

from fastapi import APIRouter

from app.api.routes import admin, health, photos, profiles, universities, verification

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(profiles.router)
api_router.include_router(photos.router)
api_router.include_router(universities.router)
api_router.include_router(verification.router)
api_router.include_router(admin.router)
