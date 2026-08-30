"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import {
  MAX_PHOTOS,
  PhotoApiError,
  deletePhoto,
  fetchPhotos,
  reorderPhotos,
  uploadPhoto,
  validatePhotoFile,
  type ProfilePhoto,
} from "@/lib/api/photos";

/**
 * Photo management shared by /onboarding (post-profile-creation step) and
 * /profile/edit. Owns its loading/mutation state and talks only to the
 * photo endpoints; ownership is decided server-side from the session token.
 * Photos render through short-lived signed URLs — storage paths are never
 * exposed to this client.
 */

const ACCEPTED_FILES = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background";

function messageFor(error: unknown): string {
  if (error instanceof PhotoApiError) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function Icon({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

function LeftIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  );
}

function RightIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path
        d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.3l-5.8 3.1 1.1-6.5L2.6 9.3l6.5-.9L12 2.5z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <Icon className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </Icon>
  );
}

export function PhotoManager() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [photos, setPhotos] = useState<ProfilePhoto[]>([]);
  const [maxPhotos, setMaxPhotos] = useState(MAX_PHOTOS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const loadPhotos = useCallback(async () => {
    const collection = await fetchPhotos();
    setPhotos(collection.photos);
    setMaxPhotos(collection.max_photos);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await loadPhotos();
        setPhase("ready");
      } catch (error) {
        console.error("Failed to load photos:", error);
        setLoadError(messageFor(error));
        setPhase("error");
      }
    })();
  }, [loadPhotos]);

  const refreshPhotos = useCallback(async () => {
    try {
      const collection = await fetchPhotos();
      setPhotos(collection.photos);
      setMaxPhotos(collection.max_photos);
    } catch (error) {
      setActionError(messageFor(error));
    }
  }, []);

  const openPicker = useCallback(() => {
    if (photos.length >= maxPhotos || uploading) {
      return;
    }
    inputRef.current?.click();
  }, [photos.length, maxPhotos, uploading]);

  const selectFile = useCallback(
    (nextFile: File | null | undefined) => {
      if (!nextFile || uploading) {
        return;
      }
      setActionError(null);
      const validationMessage = validatePhotoFile(nextFile);
      if (validationMessage) {
        setFileError(validationMessage);
        return;
      }
      setFileError(null);
      void (async () => {
        setUploading(true);
        try {
          await uploadPhoto(nextFile);
          await refreshPhotos();
        } catch (error) {
          setActionError(messageFor(error));
        } finally {
          setUploading(false);
          if (inputRef.current) {
            inputRef.current.value = "";
          }
        }
      })();
    },
    [uploading, refreshPhotos],
  );

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextFile = event.target.files?.[0] ?? null;
    event.target.value = "";
    selectFile(nextFile);
  }

  function handleDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!uploading && photos.length < maxPhotos) {
      setDragging(true);
    }
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleMove(photoId: string, offset: -1 | 1) {
    if (mutatingId) {
      return;
    }
    const index = photos.findIndex((photo) => photo.id === photoId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= photos.length) {
      return;
    }
    const nextOrder = [...photos];
    const [moved] = nextOrder.splice(index, 1);
    nextOrder.splice(target, 0, moved);

    setMutatingId(photoId);
    setActionError(null);
    try {
      const collection = await reorderPhotos(nextOrder.map((photo) => photo.id));
      setPhotos(collection.photos);
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setMutatingId(null);
    }
  }

  async function handleMakePrimary(photoId: string) {
    if (mutatingId) {
      return;
    }
    const index = photos.findIndex((photo) => photo.id === photoId);
    if (index <= 0) {
      return;
    }
    const nextOrder = [photos[index], ...photos.filter((_, i) => i !== index)];

    setMutatingId(photoId);
    setActionError(null);
    try {
      const collection = await reorderPhotos(nextOrder.map((photo) => photo.id));
      setPhotos(collection.photos);
    } catch (error) {
      setActionError(messageFor(error));
    } finally {
      setMutatingId(null);
    }
  }

  async function handleDelete(photoId: string) {
    if (mutatingId) {
      return;
    }
    setMutatingId(photoId);
    setActionError(null);
    try {
      const collection = await deletePhoto(photoId);
      setPhotos(collection.photos);
    } catch (error) {
      setActionError(messageFor(error));
      // The list may be stale after a failed delete — refresh best-effort.
      void refreshPhotos();
    } finally {
      setMutatingId(null);
    }
  }

  if (phase === "loading") {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your photos</span>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <div
              key={index}
              className="aspect-square animate-pulse rounded-2xl border border-line bg-line/50"
            />
          ))}
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="rounded-card border border-line bg-surface p-5 text-left shadow-card">
        <p role="alert" className="text-sm font-medium text-red-600">
          {loadError}
        </p>
        <button
          type="button"
          onClick={() => {
            setPhase("loading");
            setLoadError(null);
            void loadPhotos()
              .then(() => setPhase("ready"))
              .catch((error: unknown) => {
                setLoadError(messageFor(error));
                setPhase("error");
              });
          }}
          className={`mt-3 rounded-xl px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 ${FOCUS_RING}`}
        >
          Try again
        </button>
      </div>
    );
  }

  const canAddMore = photos.length < maxPhotos;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Your photos
        </h2>
        <p className="text-xs text-muted" aria-live="polite">
          {photos.length} of {maxPhotos}
        </p>
      </div>
      <p className="mt-2 text-[15px] leading-relaxed text-ink">
        Your primary photo is the first one people see in Discovery. Tap the{" "}
        <StarIcon className="inline-block size-3.5 -translate-y-px text-accent" />{" "}
        on any photo to make it primary.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((photo, index) => {
          const busy = mutatingId === photo.id;
          return (
            <div
              key={photo.id}
              className="group relative aspect-square overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
            >
              {photo.url ? (
                <Image
                  src={photo.url}
                  alt={`Profile photo ${index + 1}`}
                  fill
                  unoptimized
                  sizes="(max-width: 640px) 50vw, 200px"
                  className="object-cover"
                />
              ) : (
                <div className="grid size-full animate-pulse place-items-center bg-line/50" />
              )}

              {photo.is_primary && (
                <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-card">
                  <StarIcon className="size-2.5" />
                  Primary
                </span>
              )}

              <div
                className={`absolute inset-x-1.5 bottom-1.5 flex items-center justify-center gap-1 rounded-xl bg-surface/95 p-1 shadow-card transition-opacity ${
                  busy ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <button
                  type="button"
                  onClick={() => handleMove(photo.id, -1)}
                  disabled={busy || index === 0}
                  aria-label={`Move photo ${index + 1} earlier`}
                  className={`grid size-7 place-items-center rounded-lg text-ink transition-colors hover:bg-line/60 disabled:opacity-30 ${FOCUS_RING}`}
                >
                  <LeftIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleMakePrimary(photo.id)}
                  disabled={busy || photo.is_primary}
                  aria-label={`Make photo ${index + 1} the primary photo`}
                  className={`grid size-7 place-items-center rounded-lg text-ink transition-colors hover:bg-line/60 disabled:opacity-30 ${FOCUS_RING}`}
                >
                  <StarIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleMove(photo.id, 1)}
                  disabled={busy || index === photos.length - 1}
                  aria-label={`Move photo ${index + 1} later`}
                  className={`grid size-7 place-items-center rounded-lg text-ink transition-colors hover:bg-line/60 disabled:opacity-30 ${FOCUS_RING}`}
                >
                  <RightIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(photo.id)}
                  disabled={busy}
                  aria-label={`Delete photo ${index + 1}`}
                  className={`grid size-7 place-items-center rounded-lg text-red-600 transition-colors hover:bg-red-50 disabled:opacity-30 ${FOCUS_RING}`}
                >
                  <TrashIcon className="size-4" />
                </button>
              </div>

              {busy && (
                <span
                  className="absolute inset-0 animate-pulse bg-ink/10"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}

        {canAddMore && (
          <button
            type="button"
            onClick={openPicker}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            disabled={uploading}
            aria-busy={uploading}
            aria-label="Add a photo"
            className={`flex aspect-square flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors ${
              FOCUS_RING
            } ${
              dragging
                ? "border-accent bg-accent/5"
                : "border-line bg-surface hover:border-muted/40"
            } disabled:opacity-40`}
          >
            <PlusIcon className="size-6 text-muted" />
            <span className="mt-1.5 text-xs font-semibold text-muted">
              {uploading ? "Adding…" : "Add photo"}
            </span>
          </button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILES}
        onChange={handleInputChange}
        className="hidden"
        aria-label="Profile photo"
        disabled={uploading}
      />

      {fileError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {fileError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm font-medium text-red-600">
          {actionError}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {uploading ? "Uploading your photo" : ""}
      </p>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Drag a file onto a tile or tap to browse. JPEG, PNG, or WebP · up to
        10 MB.
      </p>
    </div>
  );
}
