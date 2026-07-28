import { describe, expect, it } from "vitest";
import { previousMonthDateRange } from "./report-dates";

describe("previousMonthDateRange", () => {
  it("returns the complete previous month without timezone shifts", () => {
    expect(previousMonthDateRange(2026, 6)).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  it("handles year boundaries", () => {
    expect(previousMonthDateRange(2026, 0)).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  it("handles leap-year February", () => {
    expect(previousMonthDateRange(2024, 2)).toEqual({
      start: "2024-02-01",
      end: "2024-02-29",
    });
  });
});
