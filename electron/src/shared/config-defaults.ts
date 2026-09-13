import type { AppConfig, ConfigCheckResult } from "./ipc-types";

/**
 * Pure config schema and merge logic.
 *
 * Deliberately free of any Electron import so it can be unit-tested directly,
 * and so it could be reused by a standalone Node entry point later.
 * Disk/env access lives in `electron/src/main/config.ts`.
 */

export const DEFAULTS: AppConfig = {
  // ── LLM ──
  LLM_PROVIDER: "deepseek",
  LLM_TEMPERATURE: "0.1",
  DEEPSEEK_API_KEY: "",
  DEEPSEEK_MODEL: "deepseek-v4-flash",
  OPENAI_API_KEY: "",
  OPENAI_MODEL: "gpt-4o",
  OPENAI_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_MODEL: "claude-sonnet-4-5",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_MAX_TOKENS: "4096",
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "",
  OLLAMA_NUM_CTX: "32768",

  // Retry/timeout policy for provider calls. `LLM_MAX_RETRIES` counts retries
  // *after* the first attempt, so 3 means up to 4 requests.
  LLM_TIMEOUT_MS: "120000",
  LLM_MAX_RETRIES: "3",
  LLM_RETRY_BASE_DELAY_MS: "4000",

  // ── Generation (agent runner) ──
  GENERATION_MAX_CARDS_PER_TOPIC: "8",
  /** Warmer than `LLM_TEMPERATURE`: cards need variety, extraction needs fidelity. */
  GENERATION_TEMPERATURE: "0.4",
  AGENT_RUNNER_ENABLED: "true",
  /** Ceiling for one whole pipeline run, separate from the per-call timeout. */
  AGENT_RUNNER_TIMEOUT_MS: "300000",

  // ── Google (Gmail + Calendar + Tasks, one OAuth2 token) ──
  GMAIL_CLIENT_ID: "",
  GMAIL_CLIENT_SECRET: "",
  GMAIL_REFRESH_TOKEN: "",
  GMAIL_USER: "me",
  GOOGLE_CALENDAR_ID: "primary",

  // ── Notifications ──
  NOTIFY_CHANNELS: "email,calendar,push",
  NOTIFY_AUTOSEND: "false",
  REMINDER_OFFSETS: "1440,60,10",
  DAILY_DIGEST_TIME: "08:00",
  WEEKLY_REVIEW_DAY: "saturday",

  // ── Study ──
  DAILY_STUDY_TARGET: "90",
  SESSION_LENGTH: "20",
  BREAK_LENGTH: "5",
  /** Local clock time the day's first study block starts at. */
  STUDY_START_TIME: "19:00",
  TIMEZONE: "America/Jamaica",
  EXAM_DATE: "",

  // ── FSRS ──
  FSRS_DESIRED_RETENTION: "0.9",
  FSRS_MAX_INTERVAL: "365",
  NEW_CARDS_PER_DAY: "20",

  // ── Syllabus ──
  SYLLABUS_ACTIVE_ID: "",
  SYLLABUS_IMPORT_FORMAT: "auto",

  // ── Appearance ──
  APPEARANCE_THEME: "system",
  APPEARANCE_ACCENT_COLOR: "#2f81f7",
  APPEARANCE_FONT_SIZE: "medium",
  APPEARANCE_SIDEBAR_WIDTH: "260",

  // ── Ops ──
  LOG_LEVEL: "info",
  USAGE_TRACKING_ENABLED: "true",
};

/** Never crossed to the renderer, never written to the shipped defaults snapshot. */
export const SECRET_CONFIG_KEYS = new Set<string>([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
]);

export const LLM_PROVIDERS = ["deepseek", "openai", "anthropic", "ollama"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const CONFIG_KEYS = Object.keys(DEFAULTS);

const PROVIDER_KEY: Record<LlmProvider, string | null> = {
  deepseek: "DEEPSEEK_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  ollama: null,
};

/** Strip keys that mean "unset", so a lower layer can show through. */
export function pruneEmpty(values: Record<string, unknown> | null | undefined): AppConfig {
  const out: AppConfig = {};
  if (!values) return out;
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("_")) continue;
    if (value === null || value === undefined) continue;
    const text = typeof value === "string" ? value : String(value);
    if (text === "") continue;
    out[key] = text;
  }
  return out;
}

/** The three-layer merge, as a pure function of its inputs. */
export function mergeConfigLayers(
  user: Record<string, unknown> | null | undefined,
  env: Record<string, unknown> | null | undefined,
  defaults: AppConfig = DEFAULTS,
): AppConfig {
  return { ...defaults, ...pruneEmpty(env), ...pruneEmpty(user) };
}

/** Resolve the effective provider, tolerating unknown or legacy values. */
export function effectiveProvider(config: AppConfig): LlmProvider {
  const raw = String(config.LLM_PROVIDER || "deepseek").toLowerCase().trim();
  return (LLM_PROVIDERS as readonly string[]).includes(raw) ? (raw as LlmProvider) : "deepseek";
}

/** Which keys must be non-empty for the app to actually work right now. */
export function requiredKeys(config: AppConfig): string[] {
  const key = PROVIDER_KEY[effectiveProvider(config)];
  return key ? [key] : [];
}

/**
 * Validate the effective config.
 * `missing` blocks the LLM; `warnings` are advisory only.
 */
export function checkConfigValues(config: AppConfig): ConfigCheckResult {
  const provider = effectiveProvider(config);
  const missing = requiredKeys(config).filter((key) => !config[key]);
  const warnings: string[] = [];

  const offsets = String(config.REMINDER_OFFSETS || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (offsets.some((part) => !Number.isFinite(Number(part)))) {
    warnings.push("REMINDER_OFFSETS contains a non-numeric value — it will be ignored.");
  }
  if (String(config.NOTIFY_AUTOSEND).toLowerCase() === "true") {
    warnings.push(
      "NOTIFY_AUTOSEND is true: emails and calendar events will be sent without a review gate.",
    );
  }
  const retention = Number(config.FSRS_DESIRED_RETENTION);
  if (Number.isFinite(retention) && (retention < 0.7 || retention > 0.98)) {
    warnings.push("FSRS_DESIRED_RETENTION outside 0.70–0.98 is unusual; 0.90 is the default.");
  }
  if (!String(config.TIMEZONE || "").trim()) {
    warnings.push("TIMEZONE is empty — reminders will use the system timezone.");
  }
  const startTime = String(config.STUDY_START_TIME || "").trim();
  if (startTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(startTime)) {
    warnings.push("STUDY_START_TIME is not a 24-hour HH:MM time — 19:00 will be used instead.");
  }
  const cardsPerTopic = Number(config.GENERATION_MAX_CARDS_PER_TOPIC);
  if (Number.isFinite(cardsPerTopic) && (cardsPerTopic < 1 || cardsPerTopic > 50)) {
    warnings.push("GENERATION_MAX_CARDS_PER_TOPIC outside 1–50 is unusual; 8 is the default.");
  }
  const genTemp = Number(config.GENERATION_TEMPERATURE);
  if (Number.isFinite(genTemp) && (genTemp < 0 || genTemp > 2)) {
    warnings.push("GENERATION_TEMPERATURE must be between 0 and 2; 0.4 will be used instead.");
  }

  // Google is advisory, never required. Every other setting still works without
  // it, so a missing token must not gate generation the way a missing provider
  // key does — which is why these keys are absent from `requiredKeys`.
  const googleKeys = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;
  const googleMissing = googleKeys.filter((key) => !String(config[key] ?? "").trim());
  if (googleMissing.length > 0 && googleMissing.length < googleKeys.length) {
    // Wholly unconfigured is the normal first-run state and not worth a warning;
    // *partly* configured is a half-finished setup and always is.
    warnings.push(
      `Google is partly configured — ${googleMissing.join(", ")} still missing. Reminders and calendar sync will not work until it is connected.`,
    );
  }
  const calendarId = String(config.GOOGLE_CALENDAR_ID ?? "").trim();
  if (googleMissing.length === googleKeys.length && calendarId && calendarId !== "primary") {
    warnings.push(
      "GOOGLE_CALENDAR_ID names a calendar but no Google credentials are set — the name will be ignored.",
    );
  }

  return { ok: missing.length === 0, missing, warnings, activeProvider: provider };
}

/** Scrub a secret before it crosses to the renderer. */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••••••${value.slice(-4)}`;
}

/** Parse a `.env` blob. Inline `#` comments are NOT stripped (accent colors break). */
export function parseDotEnv(text: string): AppConfig {
  const out: AppConfig = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}
