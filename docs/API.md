# UniMatch — API Reference

Base URL (local): `http://localhost:8000`
Interactive docs: `/docs` (Swagger UI) and `/redoc`

All endpoints are versioned under `/api/v1`.

## Conventions

- All errors share one envelope:
  `{ "error": { "code": "...", "message": "..." } }`
- Known codes today: `internal_error` (500), `validation_error` (422),
  `bad_request` (400), `unauthorized` (401), `permission_denied` (403),
  `not_found` (404), `method_not_allowed` (405), `conflict` (409).
- CORS origins are configured via the backend's `CORS_ORIGINS` setting.

## Health

### `GET /api/v1/health`

Liveness probe. No authentication.

```json
{ "status": "ok", "service": "UniMatch API", "version": "0.1.0" }
```

## Future modules (not implemented)

Auth/session, profiles, student-ID submission, verification decisions,
discovery, likes/passes, matches, messaging — **to be designed** and documented
here before implementation. Nothing beyond the health endpoint exists yet.
