"""Backend tests for the admin directory's university label.

A profile claims exactly one university: either a curated catalog row
(`university_id`) or free text (`custom_university_name`) for an institution
that is not listed. The admin user payload exposes both plus a single
`university_label` the console can render unconditionally, so a custom claim
is shown verbatim (trimmed) instead of as a blank catalog card.

The rest of the admin surface is covered by `tests/test_phase2_admin.py`.
"""

import pytest

from app.api.routes import admin_users
from tests.fakes import make_client
from tests.test_phase2_admin import (
    ADMIN,
    STAFF_HEADERS,
    TARGET_PROFILE,
    build_fake,
)


@pytest.fixture()
def fake():
    return build_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake, admin_users.router)


def test_admin_user_label_prefers_catalog_name(fake, client):
    fake.tables["profiles"][0]["university_id"] = "aaaaaaaa-0000-0000-0000-000000000001"
    body = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS).json()
    assert body["university_label"] == "State University"
    assert body["custom_university_name"] is None


def test_admin_user_label_shows_custom_university(fake, client):
    # A custom claim has no catalog row, so the join comes back empty.
    fake.tables["profiles"][0].update(
        {"university_id": None, "universities": {}}
    )
    fake.tables["profiles"][0]["custom_university_name"] = "  Hillcrest Institute  "
    body = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS).json()
    assert body["university"] is None
    assert body["custom_university_name"] == "Hillcrest Institute"
    assert body["university_label"] == "Hillcrest Institute"


def test_admin_user_label_falls_back_when_neither_university(fake, client):
    fake.tables["profiles"][0].update(
        {"university_id": None, "universities": {}, "custom_university_name": None}
    )
    body = client.get(f"{ADMIN}/users/{TARGET_PROFILE}", headers=STAFF_HEADERS).json()
    assert body["university_label"] == "University not on file"
