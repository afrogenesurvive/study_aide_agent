import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  DEFAULTS,
  SECRET_CONFIG_KEYS,
  checkConfigValues,
  effectiveProvider,
  maskSecret,
  mergeConfigLayers,
  parseDotEnv,
  pruneEmpty,
  requiredKeys,
} from "../src/shared/config-defaults";

describe("pruneEmpty", () => {
  it("drops empty strings, null, undefined and underscore-prefixed keys", () => {
    expect(
      pruneEmpty({
        KEEP: "value",
        EMPTY: "",
        NULL: null,
        UNDEFINED: undefined,
        _comment: "ignored",
      }),
    ).toEqual({ KEEP: "value" });
  });

  it("coerces non-string scalars to strings", () => {
    expect(pruneEmpty({ NUM: 90, BOOL: false, ZERO: 0 })).toEqual({
      NUM: "90",
      BOOL: "false",
      ZERO: "0",
    });
  });

  it("tolerates null input", () => {
    expect(pruneEmpty(null)).toEqual({});
  });
});

describe("mergeConfigLayers", () => {
  it("applies precedence user_config > environment > default", () => {
    const merged = mergeConfigLayers(
      { LLM_PROVIDER: "anthropic" },
      { LLM_PROVIDER: "openai", LOG_LEVEL: "debug" },
    );
    expect(merged.LLM_PROVIDER).toBe("anthropic");
    expect(merged.LOG_LEVEL).toBe("debug");
    expect(merged.DAILY_STUDY_TARGET).toBe(DEFAULTS.DAILY_STUDY_TARGET);
  });

  it("lets an empty user value fall through to the environment layer", () => {
    const merged = mergeConfigLayers({ LLM_PROVIDER: "" }, { LLM_PROVIDER: "openai" });
    expect(merged.LLM_PROVIDER).toBe("openai");
  });

  it("lets an empty environment value fall through to the default", () => {
    const merged = mergeConfigLayers({}, { TIMEZONE: "" });
    expect(merged.TIMEZONE).toBe(DEFAULTS.TIMEZONE);
  });
});

describe("effectiveProvider", () => {
  it("accepts known providers", () => {
    expect(effectiveProvider({ LLM_PROVIDER: "ollama" })).toBe("ollama");
    expect(effectiveProvider({ LLM_PROVIDER: "Anthropic " })).toBe("anthropic");
  });

  it("falls back to deepseek for unknown or missing values", () => {
    expect(effectiveProvider({ LLM_PROVIDER: "gemini" })).toBe("deepseek");
    expect(effectiveProvider({})).toBe("deepseek");
  });
});

describe("requiredKeys / checkConfigValues", () => {
  it("requires the active provider's key", () => {
    expect(requiredKeys({ ...DEFAULTS, LLM_PROVIDER: "openai" })).toEqual(["OPENAI_API_KEY"]);
    expect(requiredKeys({ ...DEFAULTS, LLM_PROVIDER: "ollama" })).toEqual([]);
  });

  it("reports a missing key and marks the config not ok", () => {
    const result = checkConfigValues({ ...DEFAULTS, LLM_PROVIDER: "deepseek" });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("DEEPSEEK_API_KEY");
    expect(result.activeProvider).toBe("deepseek");
  });

  it("is ok once the key is present", () => {
    const result = checkConfigValues({ ...DEFAULTS, DEEPSEEK_API_KEY: "sk-test" });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("warns about a non-numeric reminder offset", () => {
    const result = checkConfigValues({ ...DEFAULTS, REMINDER_OFFSETS: "1440,soon" });
    expect(result.warnings.join(" ")).toMatch(/REMINDER_OFFSETS/);
  });

  it("warns when autosend is enabled", () => {
    const result = checkConfigValues({ ...DEFAULTS, NOTIFY_AUTOSEND: "true" });
    expect(result.warnings.join(" ")).toMatch(/review gate/);
  });

  it("allows ollama to be ok with no API key", () => {
    expect(checkConfigValues({ ...DEFAULTS, LLM_PROVIDER: "ollama" }).ok).toBe(true);
  });
});

describe("maskSecret", () => {
  it("leaves empty values empty", () => {
    expect(maskSecret("")).toBe("");
  });

  it("fully masks short values", () => {
    expect(maskSecret("short")).toBe("••••••••");
  });

  it("keeps a recognisable prefix and suffix", () => {
    const masked = maskSecret("sk-abcdefghijklmnop");
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("mnop")).toBe(true);
    expect(masked).not.toContain("efghijkl");
  });
});

describe("parseDotEnv", () => {
  it("parses plain, quoted and exported values", () => {
    const parsed = parseDotEnv(
      ['LLM_PROVIDER=deepseek', 'NAME="with spaces"', "export EXPORTED=1", "# comment", ""].join(
        "\n",
      ),
    );
    expect(parsed).toEqual({
      LLM_PROVIDER: "deepseek",
      NAME: "with spaces",
      EXPORTED: "1",
    });
  });

  it("preserves an inline # in hex colours", () => {
    // Stripping inline comments would truncate this to nothing.
    expect(parseDotEnv("APPEARANCE_ACCENT_COLOR=#2f81f7").APPEARANCE_ACCENT_COLOR).toBe("#2f81f7");
  });
});

describe("schema invariants", () => {
  it("keeps every secrets key in the schema", () => {
    for (const key of SECRET_CONFIG_KEYS) expect(CONFIG_KEYS).toContain(key);
  });

  it("has a default for every key", () => {
    for (const key of CONFIG_KEYS) expect(typeof DEFAULTS[key]).toBe("string");
  });
});
