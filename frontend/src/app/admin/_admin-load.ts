"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { ApiError, isApiError } from "@/lib/api/http";

/**
 * Shared plumbing for every admin page: one loading/ready/error phase machine,
 * one unauthorized redirect, and one consistent title for each failure class.
 *
 * Staff authorization is enforced by the backend, so a 403 here means the
 * account genuinely isn't a reviewer — the page says so rather than offering a
 * retry that cannot succeed. A suspended reviewer is read-only everywhere,
 * including admin, so that state is named explicitly too.
 */

export type AdminPhase = "loading" | "ready" | "error";

interface AdminLoadState {
  phase: AdminPhase;
  error: string | null;
  errorTitle: string | null;
  /** True when retrying cannot help (auth/permission/suspension). */
  fatal: boolean;
}

const IDLE: AdminLoadState = {
  phase: "loading",
  error: null,
  errorTitle: null,
  fatal: false,
};

export function useAdminLoad(
  load: () => Promise<void>,
  deps: unknown[],
): AdminLoadState & { refresh: () => void } {
  const router = useRouter();
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<AdminLoadState>(IDLE);

  // Identity of the current request. Changing inputs (or pressing retry)
  // produces a new key; the reset is done during render rather than in an
  // effect, which is the documented way to clear state when inputs change and
  // avoids a cascading extra render.
  const key = `${deps.map(String).join("|")}#${nonce}`;
  const [prevKey, setPrevKey] = useState(key);

  if (prevKey !== key) {
    setPrevKey(key);
    setState(IDLE);
  }

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        await load();
        if (!cancelled) {
          setState({ phase: "ready", error: null, errorTitle: null, fatal: false });
        }
      } catch (caught) {
        if (cancelled) return;
        if (isApiError(caught) && caught.code === "unauthorized") {
          router.replace("/login");
          return;
        }
        const code = isApiError(caught) ? caught.code : "unknown";
        // The shared client has no `permission_denied` case, so a 403 collapses
        // to `not_verified`. That fallback is load-bearing for the public app,
        // where the same 403 means "verify your student status", so it stays.
        // Admin already knows it is in a staff-only area and reads the code as
        // "not a reviewer", supplying its own copy rather than the generic
        // verification message.
        const denied = code === "not_verified";
        setState({
          phase: "error",
          error: denied
            ? "This area is for staff reviewers only. Your account doesn't have review access."
            : isApiError(caught)
              ? caught.message
              : "Something went wrong. Please try again.",
          errorTitle: denied
            ? "Reviewer access required"
            : code === "suspended"
              ? "Account suspended"
              : "Couldn't load this",
          // A permission or suspension failure will not resolve on retry.
          fatal: denied || code === "suspended",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // `key` folds in every dependency plus the retry nonce.
  }, [key, router]); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, refresh };
}

export { ApiError };