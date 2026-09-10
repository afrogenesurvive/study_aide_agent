import { useEffect, useState } from "react";
import {
  FONT_SIZE_PRESETS,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  appearanceToConfig,
  applyAppearance,
  clampSidebarWidth,
  normalizeHex,
  type AppearanceConfig,
  type FontSizePreset,
} from "../appearance";
import { Icon } from "../icons";

const ACCENT_SWATCHES = ["#2f81f7", "#3fb950", "#d29922", "#f85149", "#a371f7", "#39c5cf"];

/**
 * Appearance settings.
 *
 * Changes preview live (the CSS custom properties are applied immediately) and
 * are only written to `config.json` when the user saves.
 */
export function AppearancePanel({
  appearance,
  onChange,
  onSaved,
}: {
  appearance: AppearanceConfig;
  onChange: (next: AppearanceConfig) => void;
  onSaved: (message: string) => void;
}) {
  const [draft, setDraft] = useState<AppearanceConfig>(appearance);
  const [accentText, setAccentText] = useState(appearance.accentColor);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(appearance);
    setAccentText(appearance.accentColor);
  }, [appearance]);

  const update = (patch: Partial<AppearanceConfig>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    applyAppearance(next); // live preview
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await window.electronAPI?.saveConfig(appearanceToConfig(draft));
      if (result?.success) {
        onChange(draft);
        onSaved("Appearance saved.");
      } else {
        onSaved(result?.error ?? "Could not save appearance.");
      }
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(appearance);

  return (
    <section className="panel">
      <header className="panel__header">
        <h2 className="panel__title">
          <Icon name="appearance" />
          Appearance
        </h2>
        <div className="panel__actions">
          <button type="button" className="btn" onClick={() => update(appearance)} disabled={!dirty}>
            Reset
          </button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="panel__body">
        <div className="field">
          <label className="field__label" htmlFor="appearance-theme">
            Theme
          </label>
          <select
            id="appearance-theme"
            className="input"
            value={draft.theme}
            onChange={(event) => update({ theme: event.target.value })}
          >
            <option value="system">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
          <p className="field__hint">“Match system” follows the OS setting and updates live.</p>
        </div>

        <div className="field">
          <span className="field__label">Accent colour</span>
          <div className="swatch-row">
            {ACCENT_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`swatch${draft.accentColor === swatch ? " swatch--active" : ""}`}
                style={{ background: swatch }}
                aria-label={`Use accent ${swatch}`}
                onClick={() => {
                  setAccentText(swatch);
                  update({ accentColor: swatch });
                }}
              />
            ))}
            <input
              className="input input--color"
              type="color"
              value={normalizeHex(draft.accentColor) ?? "#2f81f7"}
              onChange={(event) => {
                setAccentText(event.target.value);
                update({ accentColor: event.target.value });
              }}
              aria-label="Custom accent colour"
            />
            <input
              className="input input--hex"
              value={accentText}
              spellCheck={false}
              onChange={(event) => {
                setAccentText(event.target.value);
                const normalized = normalizeHex(event.target.value);
                if (normalized) update({ accentColor: normalized });
              }}
              aria-label="Accent hex value"
            />
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="appearance-font">
            Font size
          </label>
          <select
            id="appearance-font"
            className="input"
            value={draft.fontSize}
            onChange={(event) => update({ fontSize: event.target.value as FontSizePreset })}
          >
            {FONT_SIZE_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label} — {preset.description} (×{preset.scale})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="appearance-sidebar">
            Sidebar width — {draft.sidebarWidth}px
          </label>
          <input
            id="appearance-sidebar"
            className="range"
            type="range"
            min={MIN_SIDEBAR_WIDTH}
            max={MAX_SIDEBAR_WIDTH}
            step={4}
            value={draft.sidebarWidth}
            onChange={(event) => update({ sidebarWidth: clampSidebarWidth(Number(event.target.value)) })}
          />
          <p className="field__hint">You can also drag the divider next to the sidebar.</p>
        </div>
      </div>
    </section>
  );
}
