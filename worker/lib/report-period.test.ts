import { describe, expect, it } from "vitest";
import { reportPeriod } from "./report-period";

describe("reportPeriod", () => {
  it("includes the entire final UTC day", () => {
    const period = reportPeriod("2026-06-01", "2026-06-30");
    expect(period.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-06-30T23:59:59.999Z");
  });

  it("accepts leap day", () => {
    const period = reportPeriod("2028-02-01", "2028-02-29");
    expect(period.end.toISOString()).toBe("2028-02-29T23:59:59.999Z");
  });

  it("uses the workspace time zone at both boundaries", () => {
    const tokyo = reportPeriod("2026-06-01", "2026-06-30", "Asia/Tokyo");
    expect(tokyo.start.toISOString()).toBe("2026-05-31T15:00:00.000Z");
    expect(tokyo.end.toISOString()).toBe("2026-06-30T14:59:59.999Z");

    const newYork = reportPeriod("2026-03-01", "2026-03-31", "America/New_York");
    expect(newYork.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(newYork.end.toISOString()).toBe("2026-04-01T03:59:59.999Z");
  });

  it("rejects a reversed period", () => {
    expect(() => reportPeriod("2026-07-01", "2026-06-30")).toThrow("INVALID_REPORT_PERIOD");
  });
});
