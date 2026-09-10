# Changelog

Version scheme: `<package.json version>-<n>`, incrementing per wrap-up on the
current branch. Newest first.

---

## [0.0.2-1] — 2026-09-10

First working build. Implements phases 0 and 1 of
[`study_aide_implementation_plan.md`](study_aide_implementation_plan.md).

### Added

**Foundation**

- Electron + React + Vite + TypeScript application shell, with a three-layer
  configuration system (your settings file → environment / `.env` → built-in
  defaults). Every field in Settings shows which layer its value came from.
- Appearance panel: theme (system/dark/light), accent colour, five font-size
  presets, resizable sidebar.
- Configuration panel with grouped settings, a filter, secret masking, and
  export / restore-defaults.
- Developer panel: live log stream with level filtering, token-usage summary, and
  an editor for the agent config files.
- Storage panel: file locations, database size and schema version, record counts,
  and one-click database backup.
- Structured logging (in-memory ring buffer plus JSONL files) and persisted UI
  state, so the app reopens on the panel you left.

**Data and syllabus**

- Local SQLite database via Node's built-in `node:sqlite` — no native modules, so
  no compilation step on install.
- Syllabus import from **JSON, CSV, Markdown, PDF, DOCX**, or pasted text. Pasted
  prose and unstructured PDFs are structured with one LLM call; everything else is
  parsed deterministically and costs nothing.
- Four-step import flow with a change preview before anything is written, plus
  full history and rollback.
- Re-importing a syllabus updates titles, sections and time allocations while
  **preserving your progress** — status, valence and review history survive for
  every topic code that still exists.
- Removed topics are archived rather than deleted, so nothing that references them
  breaks, and they come back intact if the code reappears.
- Syllabus panel: Active (inline status + one-click valence tagging), Imports,
  Coverage, Editor (add/edit/reorder/retire).
- Coverage analytics: per-section and per-status breakdown, valence summary, and
  a required weekly pace projected from your exam date.
- Starter Cambridge A-Level outlines for 9701 Chemistry, 9709 Mathematics and 9700
  Biology, plus a seeded cross-subject overlap map.

### Notes

- The starter syllabi are **representative headings, not official
  specifications** — import your board's real document. See
  [`data/README.md`](../data/README.md).
- Requires **Node 22.5 or newer** (`node:sqlite`). `.nvmrc` pins 24.
- The LLM provider is only needed for LLM-assisted import; JSON, CSV and Markdown
  imports work entirely offline.
- Dashboard, Generate, Review, Session, Socratic, Analytics and Notifications are
  present as clearly labelled placeholders for later phases.
