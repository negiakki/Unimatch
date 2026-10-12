"""Route modules aggregated into a single v1 API router."""

from fastapi import APIRouter

from app.api.routes import (
    admin,
    admin_catalog,
    admin_opportunities,
    admin_users,
    applications,
    blocks,
    catalog,
    conversations,
    discovery,
    health,
    interests,
    matches,
    opportunities,
    opportunity_discovery,
    photos,
    profiles,
    reports,
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
api_router.include_router(conversations.router)
api_router.include_router(blocks.router)
api_router.include_router(reports.router)
api_router.include_router(catalog.router)
api_router.include_router(opportunities.router)
api_router.include_router(applications.router)
api_router.include_router(opportunity_discovery.router)
api_router.include_router(admin_catalog.router)
api_router.include_router(admin_opportunities.router)
api_router.include_router(admin_users.router)
