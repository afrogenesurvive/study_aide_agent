import { describe, expect, it } from "vitest";

import {
  addDays,
  dayEnd,
  dayKey,
  dayStart,
  daysBetween,
  formatClock,
  isValidTimeZone,
  parseClock,
  parseIso,
  isoOf,
  safeTimeZone,
  zonedTime,
} from "../services/time";

/**
 * These helpers are the only place "local time" is defined, and every scheduling
 * bug that matters comes from getting them subtly wrong, so they are tested
 * against fixed zones with known offsets rather than the machine's own zone.
 */

// Jamaica is UTC-5 all year — no DST, so it is a stable reference point.
const JAMAICA = "America/Jamaica";
// New York does observe DST, which is what the transition cases exercise.
const NEW_YORK = "America/New_York";

describe("timezone validation", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(isValidTimeZone(JAMAICA)).toBe(true);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("falls back to the machine zone rather than throwing", () => {
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    expect(safeTimeZone(JAMAICA)).toBe(JAMAICA);
    expect(safeTimeZone(null)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("dayKey", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 02:30 UTC is still the previous evening in Jamaica.
    const lateUtc = new Date("2026-09-10T02:30:00.000Z");
    expect(dayKey(lateUtc, "UTC")).toBe("2026-09-10");
    expect(dayKey(lateUtc, JAMAICA)).toBe("2026-09-09");
  });
});

describe("dayStart / dayEnd", () => {
  it("returns local midnight as a UTC instant", () => {
    const noon = new Date("2026-09-10T12:00:00.000Z");
    expect(isoOf(dayStart(noon, JAMAICA))).toBe("2026-09-10T05:00:00.000Z");
    expect(isoOf(dayEnd(noon, JAMAICA))).toBe("2026-09-11T05:00:00.000Z");
  });

  it("keeps the whole local day inside the half-open range", () => {
    const noon = new Date("2026-09-10T12:00:00.000Z");
    const start = dayStart(noon, JAMAICA).getTime();
    const end = dayEnd(noon, JAMAICA).getTime();
    const justBeforeMidnight = new Date("2026-09-11T04:59:59.000Z").getTime();
    expect(justBeforeMidnight).toBeGreaterThanOrEqual(start);
    expect(justBeforeMidnight).toBeLessThan(end);
  });

  it("handles the spring-forward transition", () => {
    // DST starts 02:00 local on 2026-03-08, so that day begins at 05:00Z (EST)
    // and the next day begins at 04:00Z (EDT).
    const during = new Date("2026-03-08T12:00:00.000Z");
    expect(isoOf(dayStart(during, NEW_YORK))).toBe("2026-03-08T05:00:00.000Z");
    const after = new Date("2026-03-09T12:00:00.000Z");
    expect(isoOf(dayStart(after, NEW_YORK))).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("zonedTime", () => {
  it("resolves a local wall-clock time to the right instant", () => {
    const anyTimeThatDay = new Date("2026-09-10T12:00:00.000Z");
    expect(isoOf(zonedTime(anyTimeThatDay, "08:00", JAMAICA))).toBe(
      "2026-09-10T13:00:00.000Z",
    );
    expect(isoOf(zonedTime(anyTimeThatDay, "08:00", "UTC"))).toBe(
      "2026-09-10T08:00:00.000Z",
    );
  });
});

describe("addDays / daysBetween", () => {
  it("crosses month and year boundaries", () => {
    expect(addDays("2026-09-10", 1)).toBe("2026-09-11");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("measures whole days in both directions", () => {
    expect(daysBetween("2026-09-01", "2026-09-10")).toBe(9);
    expect(daysBetween("2026-09-10", "2026-09-01")).toBe(-9);
    expect(daysBetween("2026-09-10", "2026-09-10")).toBe(0);
    // A DST month is 30 days of local time but still 30 calendar days.
    expect(daysBetween("2026-03-01", "2026-03-31")).toBe(30);
  });
});

describe("parseClock / formatClock", () => {
  it("parses valid clock strings to minutes past midnight", () => {
    expect(parseClock("08:00")).toBe(480);
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
  });

  it("rejects anything that is not a clock time", () => {
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("08:60")).toBeNull();
    expect(parseClock("8am")).toBeNull();
    expect(parseClock("")).toBeNull();
  });

  it("formats an instant in the target zone", () => {
    const instant = new Date("2026-09-10T13:05:00.000Z");
    expect(formatClock(instant, JAMAICA)).toBe("08:05");
    expect(formatClock(instant, "UTC")).toBe("13:05");
  });
});

describe("isoOf / parseIso", () => {
  it("round-trips an instant", () => {
    const date = new Date("2026-09-10T12:00:00.000Z");
    expect(isoOf(date)).toBe("2026-09-10T12:00:00.000Z");
    expect(parseIso(isoOf(date))?.getTime()).toBe(date.getTime());
  });

  it("parses a stored timestamp as UTC, not local time", () => {
    // This is the whole reason the ISO convention exists: SQLite's own
    // `datetime('now')` format would be read back as local time here.
    expect(parseIso("2026-09-10T12:00:00.000Z")?.getTime()).toBe(
      Date.UTC(2026, 8, 10, 12, 0, 0),
    );
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseIso(null)).toBeNull();
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso("")).toBeNull();
    expect(parseIso("not a date")).toBeNull();
  });
});
