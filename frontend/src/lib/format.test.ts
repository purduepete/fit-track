import { describe, expect, it } from "vitest";
import {
  formatDistance,
  formatDuration,
  formatLocalDateTime,
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
});
