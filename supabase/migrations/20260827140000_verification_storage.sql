-- ============================================================================
-- UniMatch — Student ID document Storage (private bucket + owner-only RLS)
--
-- Creates: private `verification-documents` Storage bucket and object access
--          policies for student ID documents.
--
-- Object path convention:
--   <auth.uid()>/<random-unique-file-id>.<extension>
--   * The first path component MUST be the authenticated user's UUID; it is
--     the only ownership signal and is enforced by every policy below.
--   * No names, student IDs, university IDs, or other personal information
--     may appear in object paths — the file id is a random unique value.
--
-- Notes:
--   * The bucket is PRIVATE (public = false). Verification documents are
--     confidential; there are deliberately no public URLs and no signed-URL
--     endpoints in this migration.
--   * Storage RLS is deny-by-default: anonymous users hold no policy and
--     therefore have NO access to the bucket or its objects.
--   * Staff/admin access is intentionally NOT implemented here. Reviewers
--     will read documents through the backend using the service role, which
--     bypasses Storage RLS; no staff Storage policy is created.
--   * Database schema (verification_submissions) is untouched: this file is
--     Storage configuration only.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Bucket: verification-documents (private)
--
-- 10 MB size limit; MIME types restricted to the photo/PDF formats accepted
-- for student ID documents. Expressed as an upsert so re-running against an
-- existing bucket converges to the intended configuration instead of
-- failing on a duplicate key.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'verification-documents',
  'verification-documents',
  false,       -- private: never publicly readable
  10485760,    -- 10 MB
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
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
-- users can neither modify nor remove verification documents. A rejected
-- verification attempt creates a NEW submission and a NEW Storage object
-- rather than replacing or deleting the previous evidence.
-- (select auth.uid()) is wrapped in a subselect so the plan evaluates it once.
-- ---------------------------------------------------------------------------

create policy "verification_documents_select_own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'verification-documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

create policy "verification_documents_insert_own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'verification-documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

-- Anonymous users: deliberately no policies — with Storage RLS enabled and
-- deny-by-default, `anon` can neither list, read, upload, modify, nor delete
-- any object in this bucket.
--
-- UPDATE/DELETE for normal users: deliberately no policies — authenticated
-- students are denied object modification and removal entirely.
--
-- Staff/admin access: intentionally absent. Reviewers will access documents
-- via the backend with the service role, which bypasses Storage RLS.
