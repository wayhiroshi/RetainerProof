export function reportPeriod(startDate: string, endDate: string, timeZone = "UTC"): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error("INVALID_REPORT_PERIOD");
  }
  if (!isValidTimeZone(timeZone)) throw new Error("INVALID_TIME_ZONE");
  const start = wallMidnightToUtc(startDate, timeZone);
  const exclusiveEnd = wallMidnightToUtc(nextDate(endDate), timeZone);
  const end = new Date(exclusiveEnd.valueOf() - 1);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start) {
    throw new Error("INVALID_REPORT_PERIOD");
  }
  return { start, end };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function reportPeriodLabel(periodStart: Date, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) throw new Error("INVALID_TIME_ZONE");
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
    timeZone,
  }).format(periodStart);
}

function wallMidnightToUtc(date: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const values = Object.fromEntries(
      formatter
        .formatToParts(new Date(guess))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const observed = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
    const correction = target - observed;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function nextDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}
