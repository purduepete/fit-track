import { describe, expect, it } from "vitest";
import {
  avgPaceSecPerUnit,
  formatDistance,
  formatDuration,
  formatHoursMinutes,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  formatPace,
  metersToUnit,
  round,
} from "./format";

describe("metersToUnit", () => {
  it("converts to miles", () => {
    expect(metersToUnit(1609.344, "mi")).toBeCloseTo(1, 5);
  });
  it("converts to km", () => {
    expect(metersToUnit(1000, "km")).toBe(1);
  });
});

describe("formatDistance", () => {
  it("formats miles", () => {
    expect(formatDistance(3218.688, "mi")).toBe("2.00 mi");
  });
  it("handles null", () => {
    expect(formatDistance(null, "mi")).toBe("—");
  });
});

describe("formatDuration", () => {
  it("under an hour is M:SS", () => {
    expect(formatDuration(125)).toBe("2:05");
  });
  it("over an hour is H:MM:SS", () => {
    expect(formatDuration(3725)).toBe("1:02:05");
  });
  it("handles null", () => {
    expect(formatDuration(null)).toBe("—");
  });
});

describe("formatPace", () => {
  it("formats seconds-per-unit", () => {
    expect(formatPace(510, "km")).toBe("8:30/km");
  });
  it("rolls 60 seconds up to the next minute", () => {
    expect(formatPace(599.6, "mi")).toBe("10:00/mi");
  });
  it("guards against zero/invalid", () => {
    expect(formatPace(0, "mi")).toBe("—");
    expect(formatPace(null, "mi")).toBe("—");
    expect(formatPace(Infinity, "mi")).toBe("—");
  });
});

describe("avgPaceSecPerUnit", () => {
  it("computes seconds per mile from distance + duration", () => {
    // 2 miles (3218.688 m) in 1200 s -> 600 s/mi
    expect(avgPaceSecPerUnit(3218.688, 1200, "mi")).toBeCloseTo(600, 5);
  });
  it("computes seconds per km", () => {
    // 2 km in 600 s -> 300 s/km
    expect(avgPaceSecPerUnit(2000, 600, "km")).toBeCloseTo(300, 5);
  });
  it("returns null for missing or zero distance", () => {
    expect(avgPaceSecPerUnit(null, 600, "mi")).toBeNull();
    expect(avgPaceSecPerUnit(1000, null, "mi")).toBeNull();
    expect(avgPaceSecPerUnit(0, 600, "mi")).toBeNull();
  });
});

describe("formatLocalTime", () => {
  it("produces a non-empty 24-hour string with no AM/PM", () => {
    const s = formatLocalTime("2026-07-05T18:39:13Z");
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toMatch(/[ap]m/i);
  });
  it("accepts an epoch-ms number", () => {
    expect(formatLocalTime(Date.now()).length).toBeGreaterThan(0);
  });
});

describe("round", () => {
  it("rounds with digits", () => {
    expect(round(3.14159, 2)).toBe("3.14");
  });
  it("handles null", () => {
    expect(round(null)).toBe("—");
  });
});

describe("formatLocalDateTime", () => {
  it("produces a non-empty string", () => {
    expect(formatLocalDateTime("2026-07-05 18:39:13").length).toBeGreaterThan(0);
  });
  it("uses MM/DD/YYYY HH:MM (24-hour)", () => {
    // A UTC datetime; the date+time render in the local zone but always MM/DD/YYYY.
    expect(formatLocalDateTime("2026-07-05T18:39:13Z")).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });
});

describe("formatLocalDate", () => {
  it("reformats a YYYY-MM-DD date string to MM/DD/YYYY without a TZ shift", () => {
    expect(formatLocalDate("2026-07-05")).toBe("07/05/2026");
    expect(formatLocalDate("2026-12-31")).toBe("12/31/2026");
  });
});

describe("formatHoursMinutes", () => {
  it("splits decimal hours into Hh Mm", () => {
    expect(formatHoursMinutes(6.311)).toBe("6h 19m");
    expect(formatHoursMinutes(7.6)).toBe("7h 36m");
  });
  it("omits minutes when whole, and hours when under one", () => {
    expect(formatHoursMinutes(7)).toBe("7h");
    expect(formatHoursMinutes(0.5)).toBe("30m");
  });
  it("handles null/invalid", () => {
    expect(formatHoursMinutes(null)).toBe("—");
    expect(formatHoursMinutes(Infinity)).toBe("—");
  });
});
