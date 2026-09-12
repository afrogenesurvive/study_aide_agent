import { useCallback, useEffect, useRef, useState } from "react";

import type {
  GenerationJobDetail,
  GenerationJobSummary,
  GenerationOutput,
  GenerationProgress,
  GenerationRequest,
  GenerationScopeKind,
  GenerationStatusPayload,
  GenerationTopicOption,
} from "../../shared/generation-types";
import type { SyllabusSummary } from "../../shared/syllabus-types";

/**
 * Generation state for the Generate panel.
 *
 * Kept in one hook because the four steps of the panel are one workflow with one
 * source of truth: choosing a scope changes what Run would do, a run changes the
 * job under review, and answering the gate changes History. Splitting this across
 * components would mean four copies of "what job am I looking at".
 */

export interface ScopeDraft {
  syllabusIds: number[];
  scope: GenerationScopeKind;
  codes: string[];
  section: string;
  /** Blank means "use `GENERATION_MAX_CARDS_PER_TOPIC`". */
  maxCardsPerTopic: string;
}

export const EMPTY_DRAFT: ScopeDraft = {
  syllabusIds: [],
  scope: "syllabus",
  codes: [],
  section: "",
  maxCardsPerTopic: "",
};

/** Turn the draft into the request the main process expects. */
export function draftToRequest(draft: ScopeDraft): GenerationRequest {
  const max = Number(draft.maxCardsPerTopic);
  return {
    scope: draft.scope,
    syllabusIds: draft.syllabusIds,
    codes: draft.scope === "topic" ? draft.codes : undefined,
    section: draft.scope === "section" ? draft.section : null,
    maxCardsPerTopic: draft.maxCardsPerTopic.trim() && Number.isFinite(max) ? max : undefined,
  };
}

export interface GenerationApi {
  status: GenerationStatusPayload | null;
  syllabi: SyllabusSummary[];
  topics: GenerationTopicOption[];
  draft: ScopeDraft;
  progress: GenerationProgress | null;
  job: GenerationJobDetail | null;
  history: GenerationJobSummary[];
  busy: string | null;
  errors: string[];
  warnings: string[];

  setDraft: (patch: Partial<ScopeDraft>) => void;
  /** Replace the chosen syllabi and reload their topics. */
  chooseSyllabi: (ids: number[]) => Promise<void>;
  refresh: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  openJob: (jobId: number) => Promise<void>;
  closeJob: () => void;
  commit: (output: GenerationOutput) => Promise<boolean>;
  reject: () => Promise<void>;
  discard: () => Promise<void>;
  dismissMessages: () => void;
}

export function useGeneration(): GenerationApi {
  const [status, setStatus] = useState<GenerationStatusPayload | null>(null);
  const [syllabi, setSyllabi] = useState<SyllabusSummary[]>([]);
  const [topics, setTopics] = useState<GenerationTopicOption[]>([]);
  const [draft, setDraftState] = useState<ScopeDraft>(EMPTY_DRAFT);
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [job, setJob] = useState<GenerationJobDetail | null>(null);
  const [history, setHistory] = useState<GenerationJobSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);

  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setDraft = useCallback((patch: Partial<ScopeDraft>) => {
    setDraftState((current) => ({ ...current, ...patch }));
  }, []);

  const refresh = useCallback(async () => {
    const [nextStatus, nextSyllabi, nextHistory] = await Promise.all([
      window.electronAPI?.getGenerationStatus(),
      window.electronAPI?.listGenerationSyllabi(),
      window.electronAPI?.getGenerationHistory(),
    ]);
    setStatus(nextStatus ?? null);
    setSyllabi(nextSyllabi ?? []);
    setHistory(nextHistory ?? []);
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistory((await window.electronAPI?.getGenerationHistory()) ?? []);
  }, []);

  const chooseSyllabi = useCallback(async (ids: number[]) => {
    setDraftState((current) => ({ ...current, syllabusIds: ids, codes: [] }));

    const loaded = await Promise.all(
      ids.map((id) => window.electronAPI?.getGenerationTopics(id) ?? Promise.resolve([])),
    );
    setTopics(loaded.flat());
  }, []);

  // Load once, and push every progress event into the same state the panel
  // renders — a run can outlive the component that started it, so the
  // subscription lives here rather than in the Run step.
  useEffect(() => {
    void refresh();

    const unsubscribe = window.electronAPI?.onGenerationProgress((next) => setProgress(next));
    return () => unsubscribe?.();
  }, [refresh]);

  const loadJob = useCallback(async (jobId: number) => {
    setJob((await window.electronAPI?.getGenerationJob(jobId)) ?? null);
  }, []);

  const start = useCallback(async () => {
    setBusy("start");
    setErrors([]);
    setWarnings([]);
    setProgress(null);
    try {
      const outcome = await window.electronAPI?.startGeneration(draftToRequest(draftRef.current));
      if (!outcome) {
        setErrors(["The app could not reach the generation service."]);
        return;
      }

      setWarnings(outcome.warnings);
      if (!outcome.ok) {
        setErrors(outcome.errors.length ? outcome.errors : ["The run failed."]);
        return;
      }

      if (outcome.jobId !== null) await loadJob(outcome.jobId);
      await refreshHistory();
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [loadJob, refresh, refreshHistory]);

  const cancel = useCallback(async () => {
    const jobId = status?.activeJobId ?? progress?.jobId ?? null;
    if (jobId === null) return;
    setBusy("cancel");
    try {
      const result = await window.electronAPI?.cancelGeneration(jobId);
      if (result && !result.success && result.error) setErrors([result.error]);
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [progress?.jobId, refresh, status?.activeJobId]);

  const commit = useCallback(
    async (output: GenerationOutput) => {
      if (!job) return false;
      setBusy("commit");
      setErrors([]);
      try {
        const result = await window.electronAPI?.commitGeneration(job.summary.id, output);
        if (!result) {
          setErrors(["The app could not reach the generation service."]);
          return false;
        }
        if (!result.success) {
          setErrors([result.error ?? "Nothing was saved."]);
          return false;
        }

        setWarnings(result.warnings);
        await loadJob(job.summary.id);
        await refreshHistory();
        await refresh();
        return true;
      } finally {
        setBusy(null);
      }
    },
    [job, loadJob, refresh, refreshHistory],
  );

  const reject = useCallback(async () => {
    if (!job) return;
    setBusy("reject");
    try {
      await window.electronAPI?.rejectGeneration(job.summary.id);
      setJob(null);
      await refreshHistory();
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [job, refresh, refreshHistory]);

  const discard = useCallback(async () => {
    if (!job) return;
    setBusy("discard");
    try {
      const result = await window.electronAPI?.discardGeneration(job.summary.id);
      if (result && !result.success && result.error) setErrors([result.error]);
      else setJob(null);
      await refreshHistory();
      await refresh();
    } finally {
      setBusy(null);
    }
  }, [job, refresh, refreshHistory]);

  const openJob = useCallback(
    async (jobId: number) => {
      setBusy("open");
      try {
        await loadJob(jobId);
      } finally {
        setBusy(null);
      }
    },
    [loadJob],
  );

  const closeJob = useCallback(() => setJob(null), []);
  const dismissMessages = useCallback(() => {
    setErrors([]);
    setWarnings([]);
  }, []);

  return {
    status,
    syllabi,
    topics,
    draft,
    progress,
    job,
    history,
    busy,
    errors,
    warnings,
    setDraft,
    chooseSyllabi,
    refresh,
    refreshHistory,
    start,
    cancel,
    openJob,
    closeJob,
    commit,
    reject,
    discard,
    dismissMessages,
  };
}
