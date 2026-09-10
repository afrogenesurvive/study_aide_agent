import { useRef, useState } from "react";
import { Icon } from "../../icons";
import { DiffPreview } from "./DiffPreview";
import type {
  CanonicalSyllabus,
  ImportFormat,
  ImportFormatHint,
  ImportPreview,
  ParseResult,
  Subject,
  SyllabusDetail,
  SyllabusImportRow,
} from "../../../shared/syllabus-types";
import { SUBJECTS, SUBJECT_LABELS } from "../../../shared/syllabus-types";

/**
 * Import tab: pick or paste a source, parse it, review the diff, commit.
 *
 * Four explicit steps rather than one button, because an overwrite silently
 * changing topics is exactly the kind of thing that should be impossible.
 */
export function ImportsTab({
  detail,
  imports,
  onChanged,
  onSaved,
}: {
  detail: SyllabusDetail | null;
  imports: SyllabusImportRow[];
  onChanged: () => Promise<void>;
  onSaved: (message: string) => void;
}) {
  const [subject, setSubject] = useState<Subject>(detail?.syllabus.subject ?? "chemistry");
  const [board, setBoard] = useState(detail?.syllabus.board ?? "cambridge");
  const [level, setLevel] = useState(detail?.syllabus.level ?? "a-level");
  const [examDate, setExamDate] = useState(detail?.syllabus.exam_date ?? "");
  const [formatHint, setFormatHint] = useState<ImportFormatHint>("auto");
  const [pastedText, setPastedText] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [parsed, setParsed] = useState<(ParseResult & { sourceName?: string }) | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reset = () => {
    setParsed(null);
    setPreview(null);
  };

  const chooseFile = (file: File) => {
    const path = window.electronAPI?.getPathForFile(file) ?? "";
    setFileName(file.name);
    setFilePath(path || null);
    setPastedText("");
    reset();
  };

  const runParse = async () => {
    setBusy("parse");
    try {
      const request = filePath
        ? { filePath, fileName: fileName ?? undefined }
        : { text: pastedText };

      if (!filePath && !pastedText.trim()) {
        onSaved("Drop a file or paste some text first.");
        return;
      }

      const result = await window.electronAPI?.parseSyllabus({
        ...request,
        format: formatHint,
        subject,
        board,
        level,
        examDate: examDate || undefined,
      });
      setParsed(result ? { ...result, sourceName: fileName ?? "pasted text" } : null);
      setPreview(null);
    } finally {
      setBusy(null);
    }
  };

  const runPreview = async () => {
    if (!parsed?.canonical) return;
    setBusy("preview");
    try {
      const result = await window.electronAPI?.previewSyllabusImport({
        canonical: parsed.canonical,
        format: parsed.format,
        sourceFile: parsed.sourceName ?? null,
        syllabusId: detail?.syllabus.id ?? null,
        examDate: examDate || null,
      });
      setPreview(result ?? null);
    } finally {
      setBusy(null);
    }
  };

  const runCommit = async () => {
    if (!parsed?.canonical) return;
    setBusy("commit");
    try {
      const result = await window.electronAPI?.commitSyllabusImport({
        canonical: parsed.canonical,
        format: parsed.format,
        sourceFile: parsed.sourceName ?? null,
        syllabusId: detail?.syllabus.id ?? null,
        examDate: examDate || null,
      });
      if (result?.success) {
        const counts = result.diff?.counts;
        onSaved(
          `Imported ${parsed.canonical.topics.length} topics — ${counts?.added ?? 0} added, ${counts?.changed ?? 0} updated, ${counts?.removed ?? 0} archived. Progress preserved.`,
        );
        reset();
        setFileName(null);
        setFilePath(null);
        setPastedText("");
        await onChanged();
      } else {
        onSaved(result?.error ?? "Import failed.");
      }
    } finally {
      setBusy(null);
    }
  };

  const canonical: CanonicalSyllabus | null = parsed?.canonical ?? null;

  return (
    <div className="imports-tab">
      <section className="import-step">
        <h3 className="step-title">
          <span className="step-number">1</span> Choose a source
        </h3>

        <div
          className={`dropzone${dragging ? " dropzone--active" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) chooseFile(file);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
          }}
        >
          <Icon name="upload" size={26} />
          <p>
            {fileName ? (
              <>
                <strong>{fileName}</strong> selected — click to change
              </>
            ) : (
              <>Drop a syllabus file here, or click to choose</>
            )}
          </p>
          <p className="muted">JSON · CSV · Markdown · PDF · DOCX — or paste below</p>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".json,.csv,.tsv,.md,.markdown,.txt,.pdf,.docx"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) chooseFile(file);
              event.target.value = "";
            }}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="import-paste">
            …or paste an outline
          </label>
          <textarea
            id="import-paste"
            className="input input--code"
            rows={5}
            placeholder={"## Physical chemistry\n### 1.1 Atomic structure\n### 1.2 Amount of substance"}
            value={pastedText}
            onChange={(event) => {
              setPastedText(event.target.value);
              setFileName(null);
              setFilePath(null);
              reset();
            }}
          />
        </div>
      </section>

      <section className="import-step">
        <h3 className="step-title">
          <span className="step-number">2</span> Details
        </h3>
        <div className="field-grid">
          <div className="field">
            <label className="field__label" htmlFor="import-subject">
              Subject
            </label>
            <select
              id="import-subject"
              className="input"
              value={subject}
              onChange={(event) => setSubject(event.target.value as Subject)}
            >
              {SUBJECTS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {SUBJECT_LABELS[candidate]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="import-board">
              Board
            </label>
            <input
              id="import-board"
              className="input"
              value={board}
              onChange={(event) => setBoard(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="import-level">
              Level
            </label>
            <input
              id="import-level"
              className="input"
              value={level}
              onChange={(event) => setLevel(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="import-format">
              Format
            </label>
            <select
              id="import-format"
              className="input"
              value={formatHint}
              onChange={(event) => setFormatHint(event.target.value as ImportFormatHint)}
            >
              <option value="auto">Detect automatically</option>
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
              <option value="md">Markdown</option>
              <option value="pdf">PDF</option>
              <option value="text">Plain text (LLM)</option>
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="import-exam">
              Exam date
            </label>
            <input
              id="import-exam"
              className="input"
              type="date"
              value={examDate ?? ""}
              onChange={(event) => setExamDate(event.target.value)}
            />
          </div>
        </div>

        <div className="toolbar">
          <button type="button" className="btn btn--primary" onClick={() => void runParse()} disabled={busy !== null}>
            {busy === "parse" ? "Parsing…" : "Parse"}
          </button>
          {parsed ? (
            <span className={`badge ${parsed.ok ? "badge--ok" : "badge--bad"}`}>
              {parsed.ok ? `${canonical?.topics.length ?? 0} topics via ${parsed.format}` : "parse failed"}
            </span>
          ) : null}
          {parsed?.usedLlm ? (
            <span className="badge badge--warn">LLM-assisted (one call)</span>
          ) : null}
        </div>

        {parsed?.error ? <div className="notice notice--error">{parsed.error}</div> : null}
        {parsed?.warnings.length ? (
          <details className="notice notice--warn">
            <summary>{parsed.warnings.length} warning(s)</summary>
            <ul className="error-list">
              {parsed.warnings.slice(0, 30).map((warning, index) => (
                <li key={`${warning.message}-${index}`}>{warning.message}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {canonical ? (
        <section className="import-step">
          <h3 className="step-title">
            <span className="step-number">3</span> Review changes
          </h3>
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              onClick={() => void runPreview()}
              disabled={busy !== null}
            >
              {busy === "preview" ? "Comparing…" : "Compare with stored syllabus"}
            </button>
            {preview ? (
              <span className="muted">
                {preview.isNewSyllabus
                  ? "Creates a new syllabus."
                  : `Updates syllabus #${preview.syllabusId}. Progress on matched codes is preserved.`}
              </span>
            ) : null}
          </div>

          {preview ? <DiffPreview diff={preview.diff} /> : null}

          <div className="toolbar">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void runCommit()}
              disabled={busy !== null}
            >
              {busy === "commit" ? "Importing…" : "Commit import"}
            </button>
            <button type="button" className="btn" onClick={reset} disabled={busy !== null}>
              Discard
            </button>
          </div>
        </section>
      ) : null}

      <section className="import-step">
        <h3 className="step-title">
          <span className="step-number">4</span> History
        </h3>
        {imports.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Subject</th>
                <th>Format</th>
                <th>Source</th>
                <th className="table__number">Topics</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {imports.map((row) => (
                <tr key={row.id}>
                  <td className="mono-note">{row.created_at}</td>
                  <td>{row.subject}</td>
                  <td>{row.format}</td>
                  <td className="muted">{row.source_file ?? "—"}</td>
                  <td className="table__number">{row.topic_count}</td>
                  <td>
                    <span className={`badge ${row.status === "applied" ? "badge--ok" : "badge--muted"}`}>
                      {row.status === "applied" ? "applied" : "rolled back"}
                    </span>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn--small"
                      disabled={row.status !== "applied"}
                      onClick={async () => {
                        const result = await window.electronAPI?.rollbackSyllabusImport(row.id);
                        onSaved(result?.success ? "Import rolled back." : result?.error ?? "Rollback failed.");
                        await onChanged();
                      }}
                    >
                      Roll back
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No imports yet.</p>
        )}
      </section>
    </div>
  );
}
