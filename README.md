# Study Aide

A local-first study system for A-level Mathematics, Chemistry and Biology.

Its premise is that **overlap-based interleaving** beats ordinary subject
rotation: instead of switching subjects arbitrarily, you study the same
conceptual theme across all three at once. *Equilibrium* in Chemistry
(Le Chatelier, Kc) is the same idea as logarithms in Mathematics and homeostasis
in Biology — and the app is built around making that connection visible.

Around that idea sit spaced repetition (FSRS), valence tagging (red = avoidance,
yellow = curiosity, green = mastered), Socratic dialogue, and an analog twin —
printable plans and overlay cards for studying away from a screen.

See [`docs/study_aide_implementation_plan.md`](docs/study_aide_implementation_plan.md)
for the full design, [`docs/CHANGELOG.md`](docs/CHANGELOG.md) for what has
shipped, and [`docs/development_environment.md`](docs/development_environment.md)
for local setup.

---

## Status

**Phase 0 (foundation) and phase 1 (data + syllabus) are implemented.**

| Phase | Scope | State |
| :-- | :-- | :-- |
| 0 | Electron + React shell, three-layer config, logging, UI state, Appearance / Configuration / Developer / Storage panels | ✅ done |
| 1 | SQLite schema + migrations, syllabus import (JSON/CSV/Markdown/PDF/DOCX/paste), diff/merge/rollback, coverage, Syllabus panel | ✅ done |
| 2 | FSRS scheduling, review + session views, Dashboard | ⏳ next |
| 3 | LLM material generation, agent runner, review gate | ⏳ |
| 4 | Gmail + Calendar MCP servers, Google settings | ⏳ |
| 5 | Notification engine, Google Tasks, native push | ⏳ |
| 6 | Socratic dialogue, analytics, printables | ⏳ |
| 7 | Polish, packaging, auto-update | ⏳ |

Screens that belong to later phases render as clearly labelled placeholders
rather than dead links.

---

## Requirements

- **Node 22.5 or newer** — the data layer uses the built-in `node:sqlite`, which
  landed in 22.5. `.nvmrc` pins 24, which is also what Electron 43 bundles.
- macOS, Windows or Linux. No Python, no native modules, no compilation step.

## Setup

```bash
nvm use                # or: nvm install
npm run setup          # installs electron/
cp .env.example .env   # optional — see Configuration below
```

## Running

```bash
npm run dev      # Vite dev server + tsc watch + Electron, all together
npm start        # run the built app (no dev server)
npm run build    # compile main + bundle renderer
npm test         # Vitest unit suite
npm run types    # type-check main, services, tests and renderer
```

---

## Configuration

Settings resolve in three layers, highest priority first:

1. **`<userData>/config.json`** — what you change in Settings → Configuration
2. **`process.env` / `.env`** — the repo `.env` in development, `<userData>/.env` when packaged
3. **Built-in defaults** — `electron/src/shared/config-defaults.ts`

Every field in the Configuration panel shows which layer its value came from, so
"why is this not what I typed?" always has a visible answer.

`config.json` lives in the app's per-user data directory, not in the repo. The
**Storage → Locations** panel shows the exact path on your machine and can open
the folder for you; see also [`docs/development_environment.md`](docs/development_environment.md).

Secrets (API keys, OAuth client secrets) are stored there and are masked before
crossing into the renderer.

### LLM providers

`LLM_PROVIDER` selects one of `deepseek` (default), `openai`, `anthropic` or
`ollama`. The provider and model are re-read on **every** call, so switching does
not need a restart. Ollama runs fully locally and needs no API key.

The provider is only required for LLM-assisted syllabus parsing (pasted text,
PDF/DOCX fallback) and the later generation/Socratic phases. Everything in
phase 1 works offline with JSON, CSV and Markdown imports.

### Where data lives

Everything sits inside the app's per-user data directory (path shown in
**Storage → Locations**):

```
<userData>/
├── study.db                 SQLite — syllabus, topics, imports, usage
├── config.json              your settings overrides
├── ui-state.json            panel/sub-tab selections, drafts
├── agent-config/            pipeline.json, tools.json, system-prompt.md
├── logs/live/<date>.jsonl   structured logs
└── backups/                 database snapshots
```

`STUDY_DB_PATH` overrides the database location; `LOG_DIR` and `LOG_LEVEL` do the
same for logging.

---

## The syllabus is the spine

Every other subsystem reads from it, so it gets its own top-level section rather
than living inside Settings. Import it once and the topic codes become the stable
identifiers that flashcards, scheduling, coverage, notifications and the Socratic
prompt all reference.

### Importing

Drop a file (JSON, CSV, Markdown, PDF, DOCX) or paste an outline. The flow is
deliberately four explicit steps:

1. **Choose a source**
2. **Details** — subject, board, level, exam date
3. **Review changes** — a diff against what is already stored
4. **History** — every import, with rollback

### What an overwrite does

Matching is on `(syllabus_id, code)`, which gives three guarantees:

- **Progress survives.** Re-importing updates titles, sections and time
  allocations, but never touches your status, valence or review history for a
  code that still exists.
- **Nothing is deleted.** Topics that vanish from the new file are *archived*, so
  anything already pointing at them keeps working. Re-adding the code restores
  the original row, history intact.
- **Everything is reversible.** Each import stores a pre-import snapshot, so
  *Roll back* restores the previous topic table exactly.

The whole application step runs in a single transaction, so a partial import is
not possible.

⚠️ The starter syllabi in `data/syllabi/` are **representative headings, not
official specifications** — see [`data/README.md`](data/README.md). Import your
board's real document; the importer will diff against the starter and preserve
whatever you have already tagged.

---

## Architecture

```
electron/
├── src/
│   ├── main/            Electron main process
│   │   ├── index.ts     window and boot order
│   │   ├── ipc/         one registrar per domain
│   │   ├── config.ts    3-layer config + child env
│   │   ├── logger.ts    ring buffer + JSONL
│   │   ├── paths.ts     userData / resource resolution
│   │   └── …            ui-state, agent-config, llm bridge
│   ├── shared/          types shared by main, services and renderer
│   └── renderer/        React (Vite) — appearance.ts, components/, styles/
├── services/            DB + syllabus domain logic (no Electron imports)
└── tests/               Vitest
```

Three conventions worth knowing:

- **The renderer is fully sandboxed.** No `nodeIntegration`; every privileged
  operation is a named `contextBridge` method. There is no generic "run this SQL"
  escape hatch.
- **`services/` never imports Electron.** It takes a database handle plus
  injected callbacks, which is why the whole data layer is unit-testable without
  stubbing the Electron runtime.
- **IPC is split by domain** (`ipc/config.ipc.ts`, `ipc/syllabus.ipc.ts`, …)
  rather than piling into one file.

## Testing

```bash
npm test
```

The suite covers the invariants that matter most: config layer precedence,
migration idempotency and transaction rollback, every deterministic parser, the
diff classification rules, progress preservation and exact rollback on
re-import, and the coverage maths (including the empty and past-exam-date edges).

## Licence

MIT — see [LICENSE](LICENSE).
