/**
 * Appearance: theme tokens, accent colour, font scale and sidebar width.
 *
 * Everything is applied as CSS custom properties on `<html>`, so the stylesheets
 * never need to know about themes — they just use `var(--bg)` and friends.
 */

export type FontSizePreset = "small" | "medium" | "large" | "x-large" | "xx-large";
export type ThemeSetting = "system" | "dark" | "light";

export interface AppearanceConfig {
  theme: string;
  accentColor: string;
  fontSize: FontSizePreset;
  sidebarWidth: number;
}

export interface FontPreset {
  label: string;
  value: FontSizePreset;
  scale: number;
  description: string;
}

export const FONT_SIZE_PRESETS: FontPreset[] = [
  { label: "Small", value: "small", scale: 0.85, description: "Compact view" },
  { label: "Medium", value: "medium", scale: 1.0, description: "Default size" },
  { label: "Large", value: "large", scale: 1.15, description: "Easier reading" },
  { label: "X-Large", value: "x-large", scale: 1.35, description: "Extra large" },
  { label: "XX-Large", value: "xx-large", scale: 1.6, description: "Double extra large" },
];

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  theme: "system",
  accentColor: "#2f81f7",
  fontSize: "medium",
  sidebarWidth: 260,
};

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 420;

interface Palette {
  bg: string;
  surface: string;
  surfaceHover: string;
  border: string;
  text: string;
  textMuted: string;
}

const DARK: Palette = {
  bg: "#0d1117",
  surface: "#161b22",
  surfaceHover: "#1c2333",
  border: "#30363d",
  text: "#e6edf3",
  textMuted: "#8b949e",
};

const LIGHT: Palette = {
  bg: "#ffffff",
  surface: "#f6f8fa",
  surfaceHover: "#eaeef2",
  border: "#d0d7de",
  text: "#1f2328",
  textMuted: "#656d76",
};

/** Back-compat: older configs stored a pixel size rather than a preset name. */
export function numericToPreset(px: number): FontSizePreset {
  if (px <= 12) return "small";
  if (px >= 22) return "xx-large";
  if (px >= 18) return "x-large";
  if (px >= 15.5) return "large";
  return "medium";
}

export function readFontPreset(config: { fontSize?: unknown }): FontSizePreset {
  const value = config.fontSize;
  if (typeof value === "number") return numericToPreset(value);
  const match = FONT_SIZE_PRESETS.find((preset) => preset.value === value);
  return match?.value ?? "medium";
}

export function fontScale(preset: FontSizePreset): number {
  return FONT_SIZE_PRESETS.find((candidate) => candidate.value === preset)?.scale ?? 1;
}

export function resolveTheme(setting: string): "dark" | "light" {
  if (setting === "dark" || setting === "light") return setting;
  return prefersDark() ? "dark" : "light";
}

export function prefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Apply every appearance token to the document root. */
export function applyAppearance(config: AppearanceConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = resolveTheme(config.theme);
  const palette = theme === "dark" ? DARK : LIGHT;

  root.style.setProperty("--bg", palette.bg);
  root.style.setProperty("--surface", palette.surface);
  root.style.setProperty("--surface-hover", palette.surfaceHover);
  root.style.setProperty("--border", palette.border);
  root.style.setProperty("--text", palette.text);
  root.style.setProperty("--text-muted", palette.textMuted);

  if (theme === "light") root.setAttribute("data-theme", "light");
  else root.removeAttribute("data-theme");

  const accent = normalizeHex(config.accentColor) ?? DEFAULT_APPEARANCE.accentColor;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", `${accent}cc`);
  root.style.setProperty("--accent-border", `${accent}44`);

  const preset = readFontPreset(config);
  const scale = fontScale(preset);
  root.style.setProperty("--fs-scale", String(scale));
  root.dataset.fontSize = preset;
  document.body.style.fontSize = `${14 * scale}px`;

  const width = clampSidebarWidth(config.sidebarWidth);
  root.style.setProperty("--sidebar-width", `${width}px`);

  root.style.setProperty("--color-red", "#f85149");
  root.style.setProperty("--color-yellow", "#d29922");
  root.style.setProperty("--color-green", "#3fb950");
}

export function clampSidebarWidth(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_APPEARANCE.sidebarWidth;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(numeric)));
}

export function normalizeHex(value: string): string | null {
  const text = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : null;
}

let mediaQuery: MediaQueryList | null = null;
let mediaListener: (() => void) | null = null;

/** Track OS theme changes while `theme === "system"`. */
export function watchSystemTheme(onChange: () => void): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  unwatchSystemTheme();
  mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaListener = () => onChange();
  mediaQuery.addEventListener("change", mediaListener);
}

export function unwatchSystemTheme(): void {
  if (mediaQuery && mediaListener) mediaQuery.removeEventListener("change", mediaListener);
  mediaQuery = null;
  mediaListener = null;
}

/** Read appearance from the effective config (values are all strings). */
export function appearanceFromConfig(config: Record<string, string>): AppearanceConfig {
  return {
    theme: config.APPEARANCE_THEME ?? DEFAULT_APPEARANCE.theme,
    accentColor: config.APPEARANCE_ACCENT_COLOR ?? DEFAULT_APPEARANCE.accentColor,
    fontSize: readFontPreset({ fontSize: config.APPEARANCE_FONT_SIZE }),
    sidebarWidth: clampSidebarWidth(Number(config.APPEARANCE_SIDEBAR_WIDTH)),
  };
}

/** Serialize back to config keys (the config layer only stores strings). */
export function appearanceToConfig(appearance: AppearanceConfig): Record<string, string> {
  return {
    APPEARANCE_THEME: appearance.theme,
    APPEARANCE_ACCENT_COLOR: normalizeHex(appearance.accentColor) ?? DEFAULT_APPEARANCE.accentColor,
    APPEARANCE_FONT_SIZE: appearance.fontSize,
    APPEARANCE_SIDEBAR_WIDTH: String(clampSidebarWidth(appearance.sidebarWidth)),
  };
}
