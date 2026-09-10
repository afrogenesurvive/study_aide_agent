import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import type { ConfigCheckResult, ConfigSourcesPayload } from "../../shared/ipc-types";

interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "password" | "number";
  options?: string[];
}

interface GroupSpec {
  id: string;
  title: string;
  note?: string;
  fields: FieldSpec[];
}

const GROUPS: GroupSpec[] = [
  {
    id: "llm",
    title: "Language model",
    note: "Provider and model are read live on every call, so changes apply without a restart.",
    fields: [
      { key: "LLM_PROVIDER", label: "Provider", options: ["deepseek", "openai", "anthropic", "ollama"] },
      { key: "LLM_TEMPERATURE", label: "Temperature", type: "number", hint: "0.0 – 2.0" },
      { key: "DEEPSEEK_API_KEY", label: "DeepSeek API key", type: "password" },
      { key: "DEEPSEEK_MODEL", label: "DeepSeek model" },
      { key: "OPENAI_API_KEY", label: "OpenAI API key", type: "password" },
      { key: "OPENAI_MODEL", label: "OpenAI model" },
      { key: "OPENAI_BASE_URL", label: "OpenAI base URL", hint: "Leave blank for the default endpoint." },
      { key: "ANTHROPIC_API_KEY", label: "Anthropic API key", type: "password" },
      { key: "ANTHROPIC_MODEL", label: "Anthropic model" },
      { key: "ANTHROPIC_MAX_TOKENS", label: "Anthropic max tokens", type: "number" },
      { key: "OLLAMA_BASE_URL", label: "Ollama base URL" },
      { key: "OLLAMA_MODEL", label: "Ollama model", hint: "Required when using the local provider." },
      { key: "OLLAMA_NUM_CTX", label: "Ollama context window", options: ["32768", "65536", "131072"] },
    ],
  },
  {
    id: "google",
    title: "Google (Gmail + Calendar + Tasks)",
    note: "One OAuth2 refresh token covers all three APIs. Wired up in phase 4.",
    fields: [
      { key: "GMAIL_CLIENT_ID", label: "OAuth client id", type: "password" },
      { key: "GMAIL_CLIENT_SECRET", label: "OAuth client secret", type: "password" },
      { key: "GMAIL_REFRESH_TOKEN", label: "Refresh token", type: "password" },
      { key: "GMAIL_USER", label: "Send as", hint: "Usually `me`." },
      { key: "GOOGLE_CALENDAR_ID", label: "Calendar", hint: "`primary` or a calendar name." },
    ],
  },
  {
    id: "study",
    title: "Study",
    fields: [
      { key: "DAILY_STUDY_TARGET", label: "Daily target (minutes)", type: "number" },
      { key: "SESSION_LENGTH", label: "Block length (minutes)", type: "number" },
      { key: "BREAK_LENGTH", label: "Break length (minutes)", type: "number" },
      { key: "TIMEZONE", label: "Timezone", hint: "IANA name, e.g. America/Jamaica." },
      { key: "EXAM_DATE", label: "Exam date", hint: "YYYY-MM-DD" },
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    note: "Every send and event creation waits at the review gate unless autosend is enabled.",
    fields: [
      { key: "NOTIFY_CHANNELS", label: "Channels", hint: "Comma separated: email, calendar, push." },
      { key: "NOTIFY_AUTOSEND", label: "Autosend without review", options: ["false", "true"] },
      { key: "REMINDER_OFFSETS", label: "Reminder offsets (minutes)", hint: "e.g. 1440,60,10 (24h, 1h, 10m)" },
      { key: "DAILY_DIGEST_TIME", label: "Daily digest time", hint: "24-hour HH:MM" },
      { key: "WEEKLY_REVIEW_DAY", label: "Weekly review day" },
    ],
  },
  {
    id: "fsrs",
    title: "Spaced repetition",
    fields: [
      { key: "FSRS_DESIRED_RETENTION", label: "Desired retention", type: "number", hint: "0.70 – 0.98; 0.90 default." },
      { key: "FSRS_MAX_INTERVAL", label: "Maximum interval (days)", type: "number" },
      { key: "NEW_CARDS_PER_DAY", label: "New cards per day", type: "number" },
    ],
  },
  {
    id: "syllabus",
    title: "Syllabus",
    fields: [
      { key: "SYLLABUS_ACTIVE_ID", label: "Active syllabus id", hint: "Set from the Syllabus panel." },
      { key: "SYLLABUS_IMPORT_FORMAT", label: "Import format", options: ["auto", "json", "csv", "md", "pdf", "text"] },
    ],
  },
  {
    id: "ops",
    title: "Diagnostics",
    fields: [
      { key: "LOG_LEVEL", label: "Log level", options: ["debug", "info", "warn", "error"] },
      { key: "USAGE_TRACKING_ENABLED", label: "Record token usage", options: ["true", "false"] },
      { key: "STUDY_DB_PATH", label: "Database path override", hint: "Requires a restart." },
    ],
  },
];

/**
 * Settings.
 *
 * Every field shows where its value came from — `user_config` (this file),
 * `environment` (.env or the shell) or `default` — because "why is this value
 * different from what I typed?" is otherwise impossible to answer.
 */
export function ConfigPanel({
  onSaved,
}: {
  onSaved: (message: string) => void;
}) {
  const [sources, setSources] = useState<ConfigSourcesPayload | null>(null);
  const [check, setCheck] = useState<ConfigCheckResult | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");

  const reload = async () => {
    const [nextSources, nextCheck] = await Promise.all([
      window.electronAPI?.getConfigWithSources(),
      window.electronAPI?.checkConfig(),
    ]);
    setSources(nextSources ?? null);
    setCheck(nextCheck ?? null);
    setDrafts({});
  };

  useEffect(() => {
    void reload();
  }, []);

  const visibleGroups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return GROUPS;
    return GROUPS.map((group) => ({
      ...group,
      fields: group.fields.filter(
        (field) =>
          field.label.toLowerCase().includes(needle) ||
          field.key.toLowerCase().includes(needle) ||
          group.title.toLowerCase().includes(needle),
      ),
    })).filter((group) => group.fields.length > 0);
  }, [filter]);

  const save = async () => {
    if (!Object.keys(drafts).length) return;
    setSaving(true);
    try {
      const result = await window.electronAPI?.saveConfig(drafts);
      onSaved(result?.success ? `Saved ${Object.keys(drafts).length} setting(s).` : result?.error ?? "Save failed.");
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const exportConfig = async () => {
    const json = (await window.electronAPI?.exportConfig()) ?? "";
    try {
      await navigator.clipboard.writeText(json);
      onSaved("Configuration copied to the clipboard (secrets excluded).");
    } catch {
      onSaved("Could not access the clipboard.");
    }
  };

  const dirtyCount = Object.keys(drafts).length;

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="settings" />
          Configuration
        </h2>
        <div className="panel__actions">
          <input
            className="input input--search"
            placeholder="Filter settings…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button type="button" className="btn" onClick={exportConfig}>
            <Icon name="download" size={14} />
            Export
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const result = await window.electronAPI?.restoreConfigDefaults();
              onSaved(result?.success ? "Restored defaults." : result?.error ?? "Restore failed.");
              await reload();
            }}
          >
            Restore defaults
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!dirtyCount || saving}>
            {saving ? "Saving…" : dirtyCount ? `Save ${dirtyCount}` : "Save"}
          </button>
        </div>
      </header>

      <div className="panel__body">
        {check ? (
          <div className={`notice${check.ok ? " notice--ok" : " notice--warn"}`}>
            <strong>{check.ok ? "Ready" : "Needs attention"}</strong>
            <span>Active provider: {check.activeProvider}</span>
            {check.missing.length ? <span>Missing: {check.missing.join(", ")}</span> : null}
            {check.warnings.map((warning) => (
              <span key={warning}>{warning}</span>
            ))}
          </div>
        ) : null}

        {sources ? (
          <p className="muted mono-note">
            config.json → {sources.configPath} · {sources.count} keys
          </p>
        ) : null}

        {visibleGroups.map((group) => (
          <fieldset key={group.id} className="fieldset">
            <legend>{group.title}</legend>
            {group.note ? <p className="field__hint">{group.note}</p> : null}
            <div className="field-grid">
              {group.fields.map((field) => (
                <ConfigField
                  key={field.key}
                  spec={field}
                  info={sources?.values[field.key]}
                  draft={drafts[field.key]}
                  onDraft={(value) => {
                    setDrafts((current) => {
                      const next = { ...current };
                      if (value === undefined) delete next[field.key];
                      else next[field.key] = value;
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}

function ConfigField({
  spec,
  info,
  draft,
  onDraft,
}: {
  spec: FieldSpec;
  info?: { value: string; source: string; secret: boolean };
  draft: string | undefined;
  onDraft: (value: string | undefined) => void;
}) {
  const current = info?.value ?? "";
  const isSet = Boolean(current);
  const secretPlaceholder = info?.secret && isSet ? current : undefined;

  return (
    <div className="field">
      <label className="field__label" htmlFor={`cfg-${spec.key}`}>
        {spec.label}
        <span className={`source-badge source-badge--${info?.source ?? "default"}`}>
          {info?.source ?? "default"}
        </span>
      </label>

      {spec.options ? (
        <select
          id={`cfg-${spec.key}`}
          className="input"
          value={draft ?? current}
          onChange={(event) => onDraft(event.target.value)}
        >
          {spec.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`cfg-${spec.key}`}
          className="input"
          type={spec.type === "password" ? "password" : spec.type === "number" ? "number" : "text"}
          value={draft ?? (spec.type === "password" ? "" : current)}
          placeholder={secretPlaceholder ?? (isSet ? "" : "not set")}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onDraft(event.target.value === "" ? undefined : event.target.value)}
        />
      )}

      {spec.hint ? <p className="field__hint">{spec.hint}</p> : null}
      {info?.secret && isSet ? <p className="field__hint">Stored — type a new value to replace it.</p> : null}
    </div>
  );
}
