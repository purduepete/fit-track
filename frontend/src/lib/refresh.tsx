import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Lets the shared app-bar "refresh" button drive whichever data page is
 * currently mounted. A page registers its own `refresh()` (from
 * `useApiResource`) and reports its `loading` flag via {@link usePageRefresh};
 * the button then triggers that refresh and spins while the fetch is in flight.
 * When no page is registered the button is disabled.
 */
interface RefreshContextValue {
  loading: boolean;
  canRefresh: boolean;
  triggerRefresh: () => void;
  registerRefresher: (fn: () => void) => void;
  unregisterRefresher: (fn: () => void) => void;
  reportLoading: (loading: boolean) => void;
}

const RefreshContext = createContext<RefreshContextValue | null>(null);

export function RefreshProvider({ children }: { children: ReactNode }) {
  const refresherRef = useRef<(() => void) | null>(null);
  const [loading, setLoading] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);

  const registerRefresher = useCallback((fn: () => void) => {
    refresherRef.current = fn;
    setCanRefresh(true);
  }, []);

  const unregisterRefresher = useCallback((fn: () => void) => {
    if (refresherRef.current === fn) {
      refresherRef.current = null;
      setCanRefresh(false);
      setLoading(false);
    }
  }, []);

  const triggerRefresh = useCallback(() => {
    refresherRef.current?.();
  }, []);

  const reportLoading = useCallback((next: boolean) => setLoading(next), []);

  return (
    <RefreshContext.Provider
      value={{ loading, canRefresh, triggerRefresh, registerRefresher, unregisterRefresher, reportLoading }}
    >
      {children}
    </RefreshContext.Provider>
  );
}

/** App-bar hook: current loading state + trigger for the refresh button. */
export function useRefreshBar() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error("useRefreshBar must be used within a RefreshProvider");
  return ctx;
}

/**
 * Page hook: wires a page's `refresh()` and `loading` flag to the app-bar
 * button for as long as the page is mounted.
 */
export function usePageRefresh(refresh: () => void, loading: boolean) {
  const ctx = useContext(RefreshContext);

  useEffect(() => {
    if (!ctx) return;
    ctx.registerRefresher(refresh);
    return () => ctx.unregisterRefresher(refresh);
  }, [ctx, refresh]);

  useEffect(() => {
    ctx?.reportLoading(loading);
  }, [ctx, loading]);
}
