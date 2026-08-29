"""Focused backend tests for the profile photo API.

Scope: HTTP-level tests of THIS backend's logic — auth handling, photo
validation (magic bytes, never the client MIME), the six-photo product limit,
append-on-upload ordering, primary-photo derivation (primary = lowest
position), ownership derivation from the token, partial-failure cleanup,
delete + compaction, reorder as a verified permutation, and the guarantee
that storage paths never reach a response.

Supabase is replaced at the `get_supabase_service_client` dependency boundary
with a small in-memory double implementing only the client surface the
backend uses. These are NOT Supabase integration tests and never touch a
network.
"""

import re
import uuid as uuid_module
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services.supabase import get_supabase_service_client

API = "/api/v1/profiles/me/photos"

STUDENT_AUTH_ID = UUID("11111111-1111-1111-1111-111111111111")
OTHER_AUTH_ID = UUID("22222222-2222-2222-2222-222222222222")
STUDENT_PROFILE_ID = UUID("33333333-3333-3333-3333-333333333333")
OTHER_PROFILE_ID = UUID("44444444-4444-4444-4444-444444444444")
VALID_TOKEN = "valid-access-token"
OTHER_TOKEN = "other-access-token"

AUTH_HEADERS = {"Authorization": f"Bearer {VALID_TOKEN}"}
MAX_BYTES = 10 * 1024 * 1024
MAX_PHOTOS = 6


# ---------------------------------------------------------------------------
# In-memory Supabase double (only the surface the backend uses).
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, tables, table_name, fail_insert_with):
        self._tables = tables
        self._table_name = table_name
        self._fail_insert_with = fail_insert_with
        self._filters: dict = {}
        self._single = False
        self._order = None
        self._limit = None
        self._insert_payload = None
        self._upsert_payload = None
        self._upsert_conflict = None
        self._delete_mode = False

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def order(self, column, desc=False):
        self._order = (column, desc)
        return self

    def limit(self, count):
        self._limit = count
        return self

    def maybe_single(self):
        self._single = True
        return self

    def insert(self, payload):
        self._insert_payload = payload
        return self

    def upsert(self, payload, on_conflict=""):
        self._upsert_payload = payload
        self._upsert_conflict = on_conflict
        return self

    def delete(self):
        self._delete_mode = True
        return self

    def _matches(self, row):
        return all(
            row.get(column) == value for column, value in self._filters.items()
        )

    def execute(self):
        table = self._tables[self._table_name]
        if self._insert_payload is not None:
            if self._fail_insert_with is not None:
                raise self._fail_insert_with
            row = dict(self._insert_payload)
            row.setdefault("id", str(uuid4()))
            table.append(row)
            return FakeResponse([row])
        if self._upsert_payload is not None:
            if self._fail_insert_with is not None:
                raise self._fail_insert_with
            conflict = self._upsert_conflict or "id"
            merged = []
            for candidate in self._upsert_payload:
                match = next(
                    (row for row in table if row.get(conflict) == candidate[conflict]),
                    None,
                )
                if match is None:
                    row = dict(candidate)
                    row.setdefault("id", str(uuid4()))
                    table.append(row)
                    merged.append(dict(row))
                else:
                    match.update(candidate)
                    merged.append(dict(match))
            return FakeResponse(merged)
        if self._delete_mode:
            removed = [dict(row) for row in table if self._matches(row)]
            self._tables[self._table_name] = [
                row for row in table if not self._matches(row)
            ]
            self._tables[self._table_name] = [
                row for row in self._tables[self._table_name]
            ]
            return FakeResponse(removed)
        matched = [dict(row) for row in table if self._matches(row)]
        if self._order is not None:
            column, desc = self._order
            matched.sort(
                key=lambda row: row.get(column) if row.get(column) is not None else 0,
                reverse=desc,
            )
        if self._limit is not None:
            matched = matched[: self._limit]
        if self._single:
            return FakeResponse(matched[0] if matched else None)
        return FakeResponse(matched)


class FakeStorageBucket:
    def __init__(self, state, fail_upload_with):
        self._state = state
        self._fail_upload_with = fail_upload_with

    def upload(self, path, file, file_options=None):
        if self._fail_upload_with is not None:
            raise self._fail_upload_with
        assert path not in self._state["objects"], "object path must be unique"
        self._state["objects"][path] = {
            "data": bytes(file),
            "options": file_options,
        }
        return FakeResponse({"path": path})

    def remove(self, paths):
        for path in paths:
            self._state["objects"].pop(path, None)
            self._state["removed"].append(path)
        return FakeResponse(list(paths))

    def create_signed_url(self, path, expires_in):
        if path not in self._state["objects"]:
            # Storage signs without existence checks; mirror that.
            pass
        return {"signedUrl": f"https://storage.test/sign/{path}?token=x&exp={expires_in}"}


class FakeStorage:
    def __init__(self, state, fail_upload_with):
        self._state = state
        self._fail_upload_with = fail_upload_with

    def from_(self, _bucket):
        return FakeStorageBucket(self._state, self._fail_upload_with)


class FakeSupabase:
    def __init__(self, users_by_token, *, fail_upload_with=None, fail_insert_with=None):
        self.tables = {"profiles": [], "profile_photos": []}
        self.state = {"objects": {}, "removed": []}
        self._fail_upload_with = fail_upload_with
        self._fail_insert_with = fail_insert_with
        self._users_by_token = users_by_token
        self.auth = self

    def get_user(self, jwt=None):
        user_id = self._users_by_token.get(jwt)
        if user_id is None:
            raise RuntimeError("invalid JWT")
        return SimpleNamespace(user=SimpleNamespace(id=user_id))

    def table(self, name):
        return FakeTable(self.tables, name, self._fail_insert_with)

    @property
    def storage(self):
        return FakeStorage(self.state, self._fail_upload_with)


# ---------------------------------------------------------------------------
# Helpers / fixtures.
# ---------------------------------------------------------------------------


def make_fake(
    *,
    photos=None,
    profiles=None,
    fail_upload_with=None,
    fail_insert_with=None,
):
    fake = FakeSupabase(
        {VALID_TOKEN: str(STUDENT_AUTH_ID), OTHER_TOKEN: str(OTHER_AUTH_ID)},
        fail_upload_with=fail_upload_with,
        fail_insert_with=fail_insert_with,
    )
    fake.tables["profiles"] = (
        profiles
        if profiles is not None
        else [
            {"id": str(STUDENT_PROFILE_ID), "auth_user_id": str(STUDENT_AUTH_ID)},
            {"id": str(OTHER_PROFILE_ID), "auth_user_id": str(OTHER_AUTH_ID)},
        ]
    )
    fake.tables["profile_photos"] = list(photos or [])
    return fake


def make_client(fake):
    app = create_app()
    app.dependency_overrides[get_supabase_service_client] = lambda: fake
    return TestClient(app)


def png_bytes(size=64):
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * size


def jpeg_bytes(size=64):
    return b"\xff\xd8\xff\xe0" + b"\x00" * size


def webp_bytes(size=64):
    return b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"\x00" * size


def gif_bytes(size=64):
    return b"GIF89a" + b"\x00" * size


def pdf_bytes(size=64):
    return b"%PDF-1.7\n" + b"\x00" * size


def photo_row(position, profile_id=STUDENT_PROFILE_ID, is_primary=None, **overrides):
    if is_primary is None:
        is_primary = position == 1
    row = {
        "id": str(uuid4()),
        "profile_id": str(profile_id),
        "storage_path": f"{uuid_module.uuid4().hex}.png",
        "position": position,
        "is_primary": is_primary,
    }
    row.update(overrides)
    return row


@pytest.fixture()
def fake():
    return make_fake()


@pytest.fixture()
def client(fake):
    return make_client(fake)


def upload(client, name="photo.png", payload=None, content_type="image/png", headers=None):
    return client.post(
        API,
        headers=headers or AUTH_HEADERS,
        files={"file": (name, payload if payload is not None else png_bytes(), content_type)},
    )


# ---------------------------------------------------------------------------
# 1. Unauthenticated requests rejected.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", API),
        ("post", API),
        ("delete", f"{API}/{uuid4()}"),
        ("put", f"{API}/order"),
    ],
)
def test_unauthenticated_requests_are_rejected(client, fake, method, path):
    kwargs = (
        {"files": {"file": ("photo.png", png_bytes(), "image/png")}}
        if method == "post"
        else ({"json": {"photo_ids": []}} if method == "put" else {})
    )
    resp = getattr(client, method)(path, **kwargs)

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert not fake.state["objects"]
    assert fake.tables["profile_photos"] == []


def test_invalid_token_is_rejected(client, fake):
    resp = upload(client, headers={"Authorization": "Bearer wrong-token"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"
    assert not fake.state["objects"]


def test_malformed_authorization_header_is_rejected(client):
    resp = upload(client, headers={"Authorization": f"Token {VALID_TOKEN}"})

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthorized"


# ---------------------------------------------------------------------------
# 2. Profile existence.
# ---------------------------------------------------------------------------


def test_upload_without_profile_is_rejected(client, fake):
    fake.tables["profiles"] = []

    resp = upload(client)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"
    assert not fake.state["objects"]
    assert fake.tables["profile_photos"] == []


def test_list_without_profile_is_rejected(client, fake):
    fake.tables["profiles"] = []

    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "profile_not_found"


# ---------------------------------------------------------------------------
# 3. Valid uploads succeed with server-authoritative ordering.
# ---------------------------------------------------------------------------


def test_first_upload_becomes_primary_at_position_one(client, fake):
    resp = upload(client)

    assert resp.status_code == 201
    body = resp.json()
    assert body["position"] == 1
    assert body["is_primary"] is True
    assert body["url"].startswith("https://storage.test/sign/")
    assert body["id"]

    assert len(fake.state["objects"]) == 1
    row = fake.tables["profile_photos"][0]
    assert row["position"] == 1
    assert row["is_primary"] is True
    stored = fake.state["objects"][row["storage_path"]]
    assert stored["data"] == png_bytes()
    assert stored["options"]["content-type"] == "image/png"


def test_second_upload_appends_and_stays_not_primary(client, fake):
    fake.tables["profile_photos"] = [photo_row(1)]
    first = fake.tables["profile_photos"][0]

    resp = upload(client, payload=jpeg_bytes(), content_type="image/jpeg")

    assert resp.status_code == 201
    body = resp.json()
    assert body["position"] == 2
    assert body["is_primary"] is False

    rows = fake.tables["profile_photos"]
    assert rows[0]["id"] == first["id"]
    assert rows[0]["is_primary"] is True
    assert rows[1]["position"] == 2
    assert rows[1]["is_primary"] is False
    assert rows[1]["storage_path"] in fake.state["objects"]


def test_object_path_is_user_scoped_and_random(client, fake):
    resp = upload(client)
    assert resp.status_code == 201
    path = next(iter(fake.state["objects"]))
    assert re.fullmatch(rf"{STUDENT_AUTH_ID}/[0-9a-f]{{32}}\.(png|jpg|webp)", path)
    assert str(STUDENT_PROFILE_ID) not in path

    other = upload(client, headers={"Authorization": f"Bearer {OTHER_TOKEN}"})
    assert other.status_code == 201
    paths = list(fake.state["objects"])
    assert any(p.startswith(f"{OTHER_AUTH_ID}/") for p in paths)


def test_upload_response_never_discloses_storage_path(client, fake):
    resp = upload(client)

    assert resp.status_code == 201
    assert "storage_path" not in resp.json()


def test_client_cannot_inject_profile_id_position_or_primary(client, fake):
    resp = client.post(
        API,
        headers=AUTH_HEADERS,
        data={
            "profile_id": str(OTHER_PROFILE_ID),
            "position": "1",
            "is_primary": "true",
            "storage_path": "hijacked/path.png",
        },
        files={"file": ("photo.png", png_bytes(), "image/png")},
    )

    assert resp.status_code == 201
    row = fake.tables["profile_photos"][0]
    assert row["profile_id"] == str(STUDENT_PROFILE_ID)
    assert row["position"] == 1
    assert row["is_primary"] is True
    assert row["storage_path"] != "hijacked/path.png"


@pytest.mark.parametrize(
    "builder,content_type",
    [(jpeg_bytes, "image/jpeg"), (webp_bytes, "image/webp")],
)
def test_all_allowed_photo_types_succeed(client, fake, builder, content_type):
    resp = upload(client, payload=builder(), content_type=content_type)

    assert resp.status_code == 201
    assert len(fake.state["objects"]) == 1


# ---------------------------------------------------------------------------
# 4. Invalid files rejected (declared MIME is never trusted alone).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "filename,content_type,payload",
    [
        ("photo.html", "text/html", png_bytes()),
        ("mismatch.png", "image/png", jpeg_bytes()),
        ("mismatch.jpg", "image/jpeg", png_bytes()),
        ("fake.png", "image/png", b"definitely not an image"),
        ("photo.gif", "image/gif", gif_bytes()),
        ("photo.pdf", "application/pdf", pdf_bytes()),
        ("empty.png", "image/png", b""),
    ],
)
def test_invalid_files_are_rejected(client, fake, filename, content_type, payload):
    resp = upload(client, name=filename, payload=payload, content_type=content_type)

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_file_type"
    assert not fake.state["objects"]
    assert fake.tables["profile_photos"] == []


# ---------------------------------------------------------------------------
# 5. Size limits.
# ---------------------------------------------------------------------------


def test_oversized_file_is_rejected(client, fake):
    oversized = png_bytes(MAX_BYTES)

    resp = upload(client, payload=oversized)

    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "file_too_large"
    assert not fake.state["objects"]
    assert fake.tables["profile_photos"] == []


def test_exactly_max_size_passes_validation(client, fake):
    exact = png_bytes(MAX_BYTES - len(png_bytes()))

    resp = upload(client, payload=exact)

    assert resp.status_code == 201
    assert fake.state["objects"]


# ---------------------------------------------------------------------------
# 6. Photo limit (six per profile).
# ---------------------------------------------------------------------------


def test_sixth_photo_is_allowed(client, fake):
    fake.tables["profile_photos"] = [photo_row(i) for i in range(1, 6)]

    resp = upload(client)

    assert resp.status_code == 201
    assert len(fake.tables["profile_photos"]) == 6


def test_photo_limit_reached_is_rejected(client, fake):
    fake.tables["profile_photos"] = [photo_row(i) for i in range(1, 7)]

    resp = upload(client)

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "photo_limit_reached"
    assert len(fake.tables["profile_photos"]) == 6
    assert not fake.state["objects"]
    assert not fake.state["removed"]


# ---------------------------------------------------------------------------
# 7. Storage failure and partial-failure cleanup.
# ---------------------------------------------------------------------------


def test_storage_failure_is_handled(client):
    fake = make_fake(fail_upload_with=RuntimeError("storage unavailable"))
    client = make_client(fake)

    resp = upload(client)

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "storage_upload_failed"
    assert fake.tables["profile_photos"] == []
    assert not fake.state["objects"]


def test_database_failure_after_upload_cleans_up_object():
    fake = make_fake(fail_insert_with=RuntimeError("database unavailable"))
    client = make_client(fake)

    resp = upload(client)

    assert resp.status_code == 503
    assert resp.json()["error"]["code"] == "database_insert_failed"
    assert fake.tables["profile_photos"] == []
    assert not fake.state["objects"]
    assert len(fake.state["removed"]) == 1


def test_position_race_cleans_up_object_and_returns_conflict():
    class PositionTaken(RuntimeError):
        pass

    fake = make_fake(
        fail_insert_with=PositionTaken(
            'duplicate key value violates unique constraint '
            '"profile_photos_profile_position_key"'
        )
    )
    client = make_client(fake)

    resp = upload(client)

    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "photo_upload_conflict"
    assert not fake.state["objects"]
    assert len(fake.state["removed"]) == 1


# ---------------------------------------------------------------------------
# 8. Listing: own photos only, ordered, signed, path never disclosed.
# ---------------------------------------------------------------------------


def test_list_returns_own_photos_in_position_order(client, fake):
    mine = [photo_row(3), photo_row(1), photo_row(2)]
    theirs = [photo_row(1, profile_id=OTHER_PROFILE_ID)]
    fake.tables["profile_photos"] = mine + theirs

    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert body["max_photos"] == MAX_PHOTOS
    photos = body["photos"]
    assert [p["position"] for p in photos] == [1, 2, 3]
    assert all(p["url"].startswith("https://storage.test/sign/") for p in photos)
    assert photos[0]["is_primary"] is True
    assert photos[1]["is_primary"] is False
    # Only the caller's own photos.
    listed_ids = {p["id"] for p in photos}
    assert listed_ids == {p["id"] for p in mine}
    assert "storage_path" not in str(body)


def test_list_empty_returns_empty_collection(client):
    resp = client.get(API, headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json() == {"photos": [], "max_photos": MAX_PHOTOS}


# ---------------------------------------------------------------------------
# 9. Delete: own photos only, compaction, primary promotion, cleanup.
# ---------------------------------------------------------------------------


def test_delete_removes_row_and_object_and_compacts(client, fake):
    rows = [photo_row(1), photo_row(2), photo_row(3)]
    fake.tables["profile_photos"] = rows
    deleted = rows[0]
    fake.state["objects"][deleted["storage_path"]] = {"data": b"x"}

    resp = client.delete(f"{API}/{deleted['id']}", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    remaining_ids = {p["id"] for p in body["photos"]}
    assert deleted["id"] not in remaining_ids
    assert [p["position"] for p in body["photos"]] == [1, 2]
    # The new first photo becomes primary.
    assert body["photos"][0]["is_primary"] is True
    assert body["photos"][1]["is_primary"] is False
    assert deleted["storage_path"] in fake.state["removed"]
    assert deleted["storage_path"] not in fake.state["objects"]


def test_delete_middle_photo_keeps_other_primary(client, fake):
    rows = [photo_row(1), photo_row(2), photo_row(3)]
    fake.tables["profile_photos"] = rows
    deleted = rows[1]

    resp = client.delete(f"{API}/{deleted['id']}", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    body = resp.json()
    assert [p["position"] for p in body["photos"]] == [1, 2]
    assert body["photos"][0]["is_primary"] is True
    assert body["photos"][0]["id"] == rows[0]["id"]


def test_delete_other_users_photo_is_not_found(client, fake):
    theirs = photo_row(1, profile_id=OTHER_PROFILE_ID)
    fake.tables["profile_photos"] = [theirs]
    fake.state["objects"][theirs["storage_path"]] = {"data": b"x"}

    resp = client.delete(f"{API}/{theirs['id']}", headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "photo_not_found"
    assert fake.tables["profile_photos"] == [theirs]
    assert theirs["storage_path"] in fake.state["objects"]
    assert not fake.state["removed"]


def test_delete_unknown_photo_is_not_found(client, fake):
    fake.tables["profile_photos"] = [photo_row(1)]

    resp = client.delete(f"{API}/{uuid4()}", headers=AUTH_HEADERS)

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "photo_not_found"


def test_delete_last_photo_leaves_empty_collection(client, fake):
    only = photo_row(1)
    fake.tables["profile_photos"] = [only]
    fake.state["objects"][only["storage_path"]] = {"data": b"x"}

    resp = client.delete(f"{API}/{only['id']}", headers=AUTH_HEADERS)

    assert resp.status_code == 200
    assert resp.json()["photos"] == []
    assert fake.tables["profile_photos"] == []


# ---------------------------------------------------------------------------
# 10. Reorder: full permutation only; first becomes primary.
# ---------------------------------------------------------------------------


def test_reorder_applies_full_order_and_primary(client, fake):
    a, b, c = photo_row(1), photo_row(2), photo_row(3)
    fake.tables["profile_photos"] = [a, b, c]

    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": [c["id"], a["id"], b["id"]]},
    )

    assert resp.status_code == 200
    body = resp.json()
    by_id = {p["id"]: p for p in body["photos"]}
    assert by_id[c["id"]]["position"] == 1
    assert by_id[c["id"]]["is_primary"] is True
    assert by_id[a["id"]]["position"] == 2
    assert by_id[a["id"]]["is_primary"] is False
    assert by_id[b["id"]]["position"] == 3
    assert by_id[b["id"]]["is_primary"] is False
    # Rows are updated in place — ids and object references survive.
    assert len(fake.tables["profile_photos"]) == 3
    row_c = next(r for r in fake.tables["profile_photos"] if r["id"] == c["id"])
    assert row_c["storage_path"] == c["storage_path"]


def test_reorder_to_first_promotes_photo_to_primary(client, fake):
    a, b = photo_row(1), photo_row(2)
    fake.tables["profile_photos"] = [a, b]

    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": [b["id"], a["id"]]},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["photos"][0]["id"] == b["id"]
    assert body["photos"][0]["is_primary"] is True


@pytest.mark.parametrize(
    "photo_ids",
    [
        lambda a, b: [a["id"]],  # incomplete
        lambda a, b: [a["id"], b["id"], str(uuid4())],  # unknown extra id
        lambda a, b: [a["id"], a["id"]],  # duplicate
        lambda a, b: [],  # non-empty photos require the full set
    ],
)
def test_reorder_rejects_non_permutations(client, fake, photo_ids):
    a, b = photo_row(1), photo_row(2)
    fake.tables["profile_photos"] = [a, b]
    before = [dict(r) for r in fake.tables["profile_photos"]]

    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": photo_ids(a, b)},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_photo_order"
    assert fake.tables["profile_photos"] == before


def test_reorder_rejects_other_users_photo_ids(client, fake):
    mine = photo_row(1)
    theirs = photo_row(1, profile_id=OTHER_PROFILE_ID)
    fake.tables["profile_photos"] = [mine, theirs]

    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": [theirs["id"], mine["id"]]},
    )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "invalid_photo_order"
    assert mine["position"] == 1
    assert mine["is_primary"] is True


def test_reorder_seven_ids_is_rejected_by_validation(client, fake):
    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": [str(uuid4()) for _ in range(7)]},
    )

    assert resp.status_code == 422


def test_reorder_empty_on_empty_is_a_no_op(client, fake):
    resp = client.put(f"{API}/order", headers=AUTH_HEADERS, json={"photo_ids": []})

    assert resp.status_code == 200
    assert resp.json()["photos"] == []


def test_reorder_never_discloses_storage_path(client, fake):
    a, b = photo_row(1), photo_row(2)
    fake.tables["profile_photos"] = [a, b]

    resp = client.put(
        f"{API}/order",
        headers=AUTH_HEADERS,
        json={"photo_ids": [b["id"], a["id"]]},
    )

    assert resp.status_code == 200
    assert "storage_path" not in str(resp.json())
