"""Application exception types shared by API routes.

Every error surfaced to clients is serialized by the handlers registered in
`app.main` into a consistent JSON envelope:

    {"error": {"code": "...", "message": "..."}}
"""

from typing import Optional


class AppError(Exception):
    """Base class for expected application errors."""

    status_code: int = 500
    code: str = "internal_error"

    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        code: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if status_code is not None:
            self.status_code = status_code
        if code is not None:
            self.code = code


class NotFoundError(AppError):
    status_code = 404
    code = "not_found"


class UnauthorizedError(AppError):
    status_code = 401
    code = "unauthorized"


class BadRequestError(AppError):
    status_code = 400
    code = "bad_request"


class PermissionDeniedError(AppError):
    status_code = 403
    code = "permission_denied"


class PayloadTooLargeError(AppError):
    status_code = 413
    code = "file_too_large"


class ConflictError(AppError):
    status_code = 409
    code = "conflict"


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "service_unavailable"


_STATUS_TO_CODE = {
    400: "bad_request",
    401: "unauthorized",
    403: "permission_denied",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "validation_error",
}


def code_for_status(status_code: int) -> str:
    """Stable error code for framework-raised HTTP errors."""
    return _STATUS_TO_CODE.get(status_code, "http_error")
