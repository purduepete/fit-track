import { useEffect, useState } from "react";
import { ApiError, clearToken } from "./api";

/**
 * Loads an authenticated API resource, centralizing the shared error handling:
 * a 401 clears the stored token and triggers `onAuthError` (log-out), while any
 * other failure is surfaced as an error string. Used by every data page so the
 * auth-failure behavior lives in exactly one place.
 *
 * `deps` controls when the resource is re-fetched (same semantics as a
 * `useEffect` dependency array). A stale in-flight request is ignored if `deps`
 * change or the component unmounts before it resolves.
 */
export function useApiResource<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  onAuthError: () => void,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    fetcher()
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) {
          clearToken();
          onAuthError();
        } else {
          setError(String(e));
        }
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error };
}
