-- ============================================================================
-- UniMatch — Profile photo Storage (private bucket + owner-only RLS)
--
-- Creates: private `profile-photos` Storage bucket and object access
--          policies for member profile photos.
--
-- Object path convention:
--   <auth.uid()>/<random-unique-file-id>.<extension>
--   * The first path component MUST be the authenticated user's UUID; it is
--     the only ownership signal and is enforced by every policy below.
--   * No names, profile IDs, or other personal information may appear in
--     object paths — the file id is a random unique value.
--
-- Notes:
--   * The bucket is PRIVATE (public = false). Profile photos are user-owned
--     data delivered only through short-lived, server-generated signed URLs
--     (the backend service-role client signs; no public URLs exist).
--   * Profile photos never mix with student ID documents: this is a separate
--     bucket from `verification-documents`, with a photo-only MIME set
--     (no PDF) and the same 10 MB size limit.
--   * Storage RLS is deny-by-default: anonymous users hold no policy and
--     therefore have NO access to the bucket or its objects.
--   * Photo rows live in the existing `profile_photos` table (core schema);
--     photo COUNT and primary-photo rules are application-level concerns of
--     the photo-management slice and are deliberately not Storage concerns.
--   * Ownership always derives from the authenticated identity — never from
--     client input. Uploads, deletes, and signing are performed by the
--     backend with the service role; the owner policies below are the
--     minimum owner-scoped surface (mirroring `verification-documents`) and
--     never grant cross-user access.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Bucket: profile-photos (private)
--
-- 10 MB size limit; MIME types restricted to the photo formats accepted for
-- member profile photos. Expressed as an upsert so re-running against an
-- existing bucket converges to the intended configuration instead of
-- failing on a duplicate key.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  false,       -- private: never publicly readable
  10485760,    -- 10 MB
  array[
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do update
set public             = excluded.public,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Storage RLS — owner-only INSERT/SELECT; UPDATE/DELETE fully denied.
--
-- Every policy is scoped BOTH to this bucket and to the first path component
-- equal to (select auth.uid()); ownership is derived from the auth claim —
-- never from client input. storage.foldername(name)[1] yields the first path
-- component ("<auth.uid()>"), so:
--   * an upload into another user's directory fails the WITH CHECK clause,
--   * reads of another user's objects match no policy rows.
-- There are deliberately NO update or delete policies: normal authenticated
-- users can neither modify nor remove photo objects directly. Photo deletion
-- is a backend workflow (service role, after ownership checks) that keeps the
-- `profile_photos` row and the Storage object in step.
-- (select auth.uid()) is wrapped in a subselect so the plan evaluates it once.
-- ---------------------------------------------------------------------------

-- Drop-first: makes the migration idempotent against remote databases that
-- already contain these policies (e.g. applied out-of-band or via the
-- dashboard), while recreating them with the exact intended definition below.
drop policy if exists "profile_photos_storage_select_own" on storage.objects;
drop policy if exists "profile_photos_storage_insert_own" on storage.objects;

create policy "profile_photos_storage_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'profile-photos'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "profile_photos_storage_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- Anonymous users: deliberately no policies — with Storage RLS enabled and
-- deny-by-default, `anon` can neither list, read, upload, modify, nor delete
-- any object in this bucket.
--
-- UPDATE/DELETE for normal users: deliberately no policies — photos are
-- removed only through the backend, which owns row/object consistency.
