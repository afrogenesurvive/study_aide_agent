import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * UI state persistence.
 *
 * High-frequency view state (active panel, sub-tabs, filters, drafts) lives here
 * rather than in config.json, because config writes restart child services while
 * this is written on nearly every interaction. Writes are debounced, and the
 * renderer is the single writer.
 */

type UiState = Record<string, unknown>;

interface UiStateContextValue {
  ready: boolean;
  state: UiState;
  get: <T>(path: string, fallback: T) => T;
  set: (path: string, value: unknown) => void;
  clearScope: (prefix: string) => void;
  reset: () => void;
}

const UiStateContext = createContext<UiStateContextValue | null>(null);

const SAVE_DEBOUNCE_MS = 400;

function readPath(source: UiState, path: string): unknown {
  let cursor: unknown = source;
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function writePath(source: UiState, path: string, value: unknown): UiState {
  const segments = path.split(".");
  const next: UiState = { ...source };
  let cursor: UiState = next;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const current = cursor[segment];
    const clone = current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as UiState) }
      : {};
    cursor[segment] = clone;
    cursor = clone;
  }
  const last = segments[segments.length - 1];
  if (value === undefined) delete cursor[last];
  else cursor[last] = value;
  return next;
}

export function UiStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UiState>({});
  const [ready, setReady] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<UiState>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = (await window.electronAPI?.getUiState()) ?? {};
        if (cancelled) return;
        latest.current = loaded;
        setState(loaded);
      } catch {
        // Corrupt or unavailable state should never block startup.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Flush on unload so a quick quit does not lose the last change.
  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      void window.electronAPI?.saveUiState(latest.current);
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, []);

  const schedule = useCallback((next: UiState) => {
    latest.current = next;
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void window.electronAPI?.saveUiState(latest.current);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const get = useCallback(
    <T,>(path: string, fallback: T): T => {
      const value = readPath(latest.current, path);
      return (value === undefined ? fallback : value) as T;
    },
    [],
  );

  const set = useCallback(
    (path: string, value: unknown) => {
      schedule(writePath(latest.current, path, value));
    },
    [schedule],
  );

  const clearScope = useCallback(
    (prefix: string) => {
      const next: UiState = { ...latest.current };
      delete next[prefix];
      schedule(next);
    },
    [schedule],
  );

  const reset = useCallback(() => schedule({}), [schedule]);

  const value = useMemo<UiStateContextValue>(
    () => ({ ready, state, get, set, clearScope, reset }),
    [ready, state, get, set, clearScope, reset],
  );

  return <UiStateContext.Provider value={value}>{children}</UiStateContext.Provider>;
}

export function useUiState(): UiStateContextValue {
  const context = useContext(UiStateContext);
  if (!context) throw new Error("useUiState must be used inside <UiStateProvider>.");
  return context;
}

/** Read (and auto-persist) a single dotted-path value. */
export function useUiStateValue<T>(path: string, fallback: T): [T, (value: T) => void] {
  const { ready, get, set, state } = useUiState();
  const value = ready ? get(path, fallback) : fallback;
  const update = useCallback((next: T) => set(path, next), [path, set]);
  // `state` is referenced so the hook re-renders when the value changes.
  void state;
  return [value, update];
}
