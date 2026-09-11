# Changelog

Version scheme: `<package.json version>-<n>`, incrementing per wrap-up on the
current branch. Newest first.

---

## [0.0.1-3] — 2026-09-11

Documentation only — no application changes.

- Updated the development environment guide for phase 2: current test and schema
  figures, the startup log lines to expect, and a new note on how scheduling dates
  are stored.
- Recorded the remaining known gaps, including the parts of the app that are
  covered by unit tests but have never been exercised at runtime.

---

## [0.0.1-2] — 2026-09-10

Phase 2 — spaced repetition and scheduling. The Dashboard, Review and Session
sections are now real rather than placeholders.

### Added

**Card review, with FSRS scheduling**

- Cards are scheduled by `ts-fsrs` (FSRS v6). Each of the four rating buttons —
  Again / Hard / Good / Easy — shows the interval it *would* schedule before you
  commit to it, so the choice is informed rather than a guess.
- Keyboard shortcuts: space to reveal the answer, `1`–`4` to rate, `u` to undo.
- **Undo is exact.** Every review is logged with the full scheduler state, so
  undoing restores the previous schedule rather than approximating it.
- Valence tags (struggling / curious / mastered) can be set per card.
- A card library for filtering and archiving, and a manual **Add** form, so the
  review loop works before generated material arrives. Cards are attached to
  syllabus topics, which is what lets them be scheduled into the right subject.

**Dashboard**

- Today's plan with times, cards to review, new cards remaining, day streak,
  syllabus coverage and days until your exam.
- The day's cross-subject theme, a per-subject breakdown of what is due, and a
  "needs attention" list of topics you have flagged as struggling.
- With no syllabus imported, it points you at the Syllabus section instead of
  showing empty statistics.

**Session**

- Timed interleaved study blocks: intention → subject A, break, subject B, break,
  subject C → synthesis. Overlay connections for the current subject are shown
  while you work.
- A per-block countdown timer with pause, and a notes field that is kept as you
  type. Finishing a session logs it and moves the topics you covered forward.

**Scheduling**

- Sessions are built around a **cross-subject theme** when one connects at least
  two subjects you actually have cards due in, and fall back to your most overdue
  topic per subject otherwise. The dashboard explains which it chose and why.
- Four seeded themes (Equilibrium, Exponential Change, Energy, Structure and
  Bonding) link Chemistry, Maths and Biology by syllabus topic.
- New setting: **Study start time**, which anchors the times shown on the plan.

### Fixed

- Imports that describe structure with section headings — most CSV and Markdown
  files — now build the topic hierarchy they imply, instead of importing flat.
- Archiving removed topics during an import is no longer quadratic; large
  re-imports are noticeably faster.
- A second launch of the app no longer briefly opens a window on its way out.
- The Syllabus Editor can now set, change, **or clear** a topic's parent. The
  picker will not let you create a loop.

### Under the hood

- Database schema v2: a review log, and theme tables seeded from the bundled
  overlay map. Existing databases upgrade in place.
- Scheduling dates are stored in UTC throughout, so plans are not skewed by your
  machine's timezone.
- Removed dead code found in the phase 0–1 audit.
- 328 tests passing, up from 97.

---

## [0.0.1-1] — 2026-09-10

Bug fixes for the syllabus importer and the Developer panel.

### Fixed

- **Re-importing a syllabus no longer loses topic hierarchy.** Previously, if an
  imported file did not mention parent topics, every existing parent link was
  cleared — silently flattening the syllabus. A file that is silent about
  hierarchy now leaves what is there alone. Structure is still updated, and
  topics are still re-parented, when the incoming file actually says so.
- **Developer panel no longer re-reads token usage on every log line.** With the
  Usage tab open, each incoming log entry triggered a fresh database read. The
  tab now loads when you open it, and has a **Refresh** button.

### Under the hood

- Removed a deprecated TypeScript compiler option (`baseUrl`) that was reporting
  an error, and corrected the `@/*` path alias to be relative so it still
  resolves. No behaviour change.
- Added four regression tests covering parent-link survival across re-imports
  (97 tests passing, up from 93).

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
