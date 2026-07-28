function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function previousMonthDateRange(currentYear: number, currentMonthIndex: number): {
  start: string;
  end: string;
} {
  const previousMonthLastDay = new Date(Date.UTC(currentYear, currentMonthIndex, 0));
  const year = previousMonthLastDay.getUTCFullYear();
  const month = previousMonthLastDay.getUTCMonth() + 1;
  const lastDay = previousMonthLastDay.getUTCDate();

  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(lastDay)}`,
  };
}
