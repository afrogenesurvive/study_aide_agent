# Development environment

Everything needed to run, build and debug Study Aide locally.

> This is the public summary. If you maintain a private fork with machine-specific
> notes, keep those in a separate ignored file rather than here.

---

## Requirements

| Requirement | Value | Why |
| :--- | :--- | :--- |
| Node | **≥ 22.5** (`.nvmrc` pins `24`) | The data layer uses the built-in `node:sqlite`, added in 22.5. |
| Electron | 43.x | Bundles a Node runtime that includes `node:sqlite`, so no native rebuild is needed. |

No Python, no native modules, no compilation step.

## Setup

```bash
nvm use                # or: nvm install
npm run setup          # installs electron/
npm run build          # required before `npm start`
```

### Install gotcha: npm blocks lifecycle scripts

Recent npm versions do not run install scripts by default, which means **Electron's
binary is never downloaded** and `electron .` fails with a missing-executable
error. If that happens:

```bash
cd electron
node node_modules/electron/install.js
```

You should then see `Electron.app` inside `electron/node_modules/electron/dist`.
Vite's bundler is unaffected — it resolves its platform binary through an optional
dependency rather than a postinstall.

## Commands

```bash
npm run dev        # Vite dev server + tsc --watch + Electron, together
npm start          # run the built app (no dev server)
npm run build      # compile the main process, then bundle the renderer
npm test           # Vitest unit suite
npm run types      # type-check all three projects
```

`npm run dev` waits for both the Vite port and the compiled main process before
launching Electron, so the first run includes one full compile.

`npm start` runs the unpackaged app. It tries the dev server first and falls back
to the built renderer if nothing is listening, so it works on a built tree without
any extra flag.

## Where your data lives

Application state is kept in the standard per-user application data directory for
your platform (the Electron `userData` folder). The exact path is shown in the app
under **Storage → Locations**, with buttons to open each folder.

In there you will find the database, your settings, the seeded agent-config files,
logs, and database backups. Deleting that folder resets the app to a first-run
state; nothing in the repository depends on it.

You can relocate the database with the `STUDY_DB_PATH` environment variable, and
logs with `LOG_DIR` / `LOG_LEVEL`.

## How configuration resolves

1. Your settings file — what you change in Settings → Configuration (highest)
2. `process.env`, seeded from a `.env` file in the repo root (development) or the
   user-data directory (packaged). A real environment variable wins over `.env`.
3. Built-in defaults.

Settings → Configuration labels every field with the layer it came from, which is
the quickest way to answer "why isn't this my value?".

Secrets are masked before they reach the interface.

## Build output layout

The main process compiles to `electron/dist/src/main/`, the renderer bundles to
`electron/dist/renderer/`. `package.json` points at the compiled entry point —
build before running.

The renderer tsconfig defines an `@/*` path alias with no `baseUrl`. If you ever
remove it, remove the matching `resolve.alias` in `vite.config.ts` too — leaving
one without the other means the bundler resolves an import TypeScript cannot
check.

## Scheduling data

Review dates are stored in UTC, and the timezone in Settings is the single source
of truth for what "today" means — so day boundaries, streaks and plan start times
stay correct wherever you are, including across daylight-saving changes.

Do not store a review date using SQLite's own `datetime('now')`. It carries no
timezone marker, so it reads back as *local* time and silently shifts every
scheduled interval by your UTC offset.

The cross-subject overlay themes come from the bundled `data/overlap-map.json`,
which is re-applied on every launch. Editing that file and restarting is enough to
change which themes the scheduler can build a session around.

## Language model calls

Generation calls are bounded and retried. Each attempt has a timeout, transient
failures — rate limits, server errors, dropped connections — are retried with
exponential backoff, and cancelling from the interface stops the run immediately
rather than waiting for the retry policy to finish.

Provider settings resolve on every call, so changing the model in Settings takes
effect without a restart. If the selected provider has no API key, the call fails
fast with a message naming the missing setting rather than a generic error.

Anything that reaches the model is scrubbed first. The built-in scrub always
strips null bytes, code fences and the common instruction-override phrasings, and
truncates long input; a private pattern set can be layered on top of it, and its
absence never disables the built-in one.

## Usage costs are estimates

Tokens are recorded per call, and a cost is shown wherever the model has a known
rate. Costs are computed locally from a rate table that ships with the app, and
**those rates are indicative placeholders rather than quotes** — providers change
pricing without notice. Confirm them against your own billing page, or supply
your own figures.

A model with no known rate is shown with no cost at all. A zero would read as
"this call was free", which is a different and worse claim than "unknown".

## Manual verification

```bash
npm run types && npm test && npm run build
```

Then launch the app and check the Developer panel: you should see a startup line,
a configuration line, and a `Database ready` line reporting the schema version,
table count and journal mode. That last line appears only on the first run for a
fresh database — its absence on a second run is the migration idempotency check.

### Checking the interface without the app

Opening `electron/dist/renderer/index.html` in a browser renders the shell. Every
IPC call is optional, so it degrades to "Database unavailable" / "LLM not
configured" and is useful for checking layout and styling changes quickly.

## Current limitations

- macOS is the only platform this has been exercised on. Windows and Linux paths
  are written but untested.
- No packaging, auto-update or release pipeline yet — that is phase 7.
- Material generation is **half-built**: the database schema, the pipeline engine
  and the provider layer are in place and covered by unit tests, but the Generate
  screen and the review gate have not been written, so none of that has been run
  end to end yet.
- The cost figures described above have never been reconciled against a real
  provider bill.
