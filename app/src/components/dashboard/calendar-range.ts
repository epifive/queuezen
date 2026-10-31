/** Date ranges of the calendar views ("YYYY-MM-DD" days, UTC date math). Shared by the page and the board. */

export type CalendarView = "month" | "week" | "list";

export function addDaysStr(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** First day shown for a view anchored at `day` (month grid starts on the week start). */
export function rangeOf(view: CalendarView, day: string, weekStart: 1 | 7): { start: string; days: number } {
  const startOfWeek = (d: string) => {
    const wd = weekdayOf(d);
    const offset = weekStart === 1 ? wd - 1 : wd % 7;
    return addDaysStr(d, -offset);
  };
  if (view === "week") return { start: startOfWeek(day), days: 7 };
  const first = `${day.slice(0, 7)}-01`;
  if (view === "list") {
    const [y, m] = first.split("-").map(Number);
    return { start: first, days: new Date(Date.UTC(y, m, 0)).getUTCDate() };
  }
  const gridStart = startOfWeek(first);
  const [y, m] = first.split("-").map(Number);
  const last = `${first.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  let days = 0;
  for (let d = gridStart; d <= last || days % 7 !== 0; d = addDaysStr(d, 1)) days++;
  return { start: gridStart, days };
}
