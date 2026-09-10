import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { useUiStateValue } from "../hooks/useUiState";
import type {
  CoverageReport,
  SyllabusDetail,
  SyllabusImportRow,
  SyllabusSummary,
} from "../../shared/syllabus-types";
import { ActiveTab } from "./syllabus/ActiveTab";
import { CoverageTab } from "./syllabus/CoverageTab";
import { EditorTab } from "./syllabus/EditorTab";
import { ImportsTab } from "./syllabus/ImportsTab";

type SubTab = "active" | "imports" | "coverage" | "editor";

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "active", label: "Active" },
  { id: "imports", label: "Imports" },
  { id: "coverage", label: "Coverage" },
  { id: "editor", label: "Editor" },
];

/**
 * The Syllabus section.
 *
 * The syllabus is the single source of truth for every other subsystem, so it
 * gets its own top-level section rather than living inside Settings: topic codes
 * feed material generation, the scheduler, coverage analytics, notifications and
 * the Socratic system prompt.
 */
export function SyllabusPanel({ onSaved }: { onSaved: (message: string) => void }) {
  const [subTab, setSubTab] = useUiStateValue<SubTab>("syllabus.subTab", "active");
  const [syllabi, setSyllabi] = useState<SyllabusSummary[]>([]);
  const [selectedId, setSelectedId] = useUiStateValue<number | null>("syllabus.selectedId", null);
  const [detail, setDetail] = useState<SyllabusDetail | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [imports, setImports] = useState<SyllabusImportRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const list = (await window.electronAPI?.listSyllabi()) ?? [];
    setSyllabi(list);

    const targetId =
      selectedId && list.some((row) => row.id === selectedId)
        ? selectedId
        : (list.find((row) => row.is_active) ?? list[0])?.id ?? null;

    if (targetId !== selectedId) setSelectedId(targetId);

    if (!targetId) {
      setDetail(null);
      setCoverage(null);
      setImports([]);
      return;
    }

    const [nextDetail, nextCoverage, nextImports] = await Promise.all([
      window.electronAPI?.getSyllabus(targetId),
      window.electronAPI?.getCoverage(targetId),
      window.electronAPI?.listSyllabusImports(targetId),
    ]);
    setDetail(nextDetail ?? null);
    setCoverage(nextCoverage ?? null);
    setImports(nextImports ?? []);
  };

  useEffect(() => {
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const counts = useMemo(
    () => ({
      topics: detail?.topics.length ?? 0,
      covered: coverage?.byStatus
        ? coverage.byStatus.introduced + coverage.byStatus.learning + coverage.byStatus.mastered
        : 0,
      mastered: coverage?.byStatus.mastered ?? 0,
    }),
    [detail, coverage],
  );

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="syllabus" />
          Syllabus
        </h2>
        <div className="panel__actions">
          {syllabi.length ? (
            <select
              className="input input--compact"
              value={selectedId ?? ""}
              onChange={(event) => setSelectedId(Number(event.target.value) || null)}
              aria-label="Selected syllabus"
            >
              {syllabi.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.subject} · {row.board} {row.level} · {row.topic_count} topics
                </option>
              ))}
            </select>
          ) : null}
          <button type="button" className="btn" onClick={() => void refresh()}>
            <Icon name="refresh" size={14} />
            Refresh
          </button>
        </div>
      </header>

      <div className="tab-row tab-row--panel" role="tablist">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            className={`tab${subTab === tab.id ? " tab--active" : ""}`}
            onClick={() => setSubTab(tab.id)}
          >
            {tab.label}
            {tab.id === "imports" && imports.length ? <span className="tab__count">{imports.length}</span> : null}
          </button>
        ))}
      </div>

      <div className="panel__body">
        {loading ? <p className="muted">Loading…</p> : null}

        {!loading && !detail && subTab !== "imports" ? (
          <div className="empty-state">
            <Icon name="syllabus" size={32} />
            <h3>No syllabus yet</h3>
            <p className="muted">
              Import a Cambridge A-Level outline (JSON, CSV, Markdown, PDF, DOCX) or paste one in.
              Everything downstream — flashcards, scheduling, coverage — reads from it.
            </p>
            <button type="button" className="btn btn--primary" onClick={() => setSubTab("imports")}>
              Import a syllabus
            </button>
          </div>
        ) : null}

        {detail && subTab === "active" ? (
          <ActiveTab
            detail={detail}
            counts={counts}
            onChanged={refresh}
            onSaved={onSaved}
          />
        ) : null}

        {subTab === "imports" ? (
          <ImportsTab
            detail={detail}
            imports={imports}
            onChanged={refresh}
            onSaved={onSaved}
          />
        ) : null}

        {detail && subTab === "coverage" ? <CoverageTab coverage={coverage} /> : null}

        {detail && subTab === "editor" ? (
          <EditorTab detail={detail} onChanged={refresh} onSaved={onSaved} />
        ) : null}
      </div>
    </section>
  );
}
