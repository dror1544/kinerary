export function datesInPhase(dates?: { start?: string; end?: string }): string[] {
  const start = dates?.start;
  const end = dates?.end || start;
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  const out: string[] = [];
  // UTC throughout: these are calendar dates, and a local-midnight Date shifts
  // them by a day for anyone east or west of the machine that renders it.
  for (let day = new Date(`${start}T00:00:00Z`); day <= new Date(`${end}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    out.push(day.toISOString().slice(0, 10));
    if (out.length > 400) break;  // a trip, not a century
  }
  return out;
}

// Calendar dates remain visible even when only some days have planned content.
export function phaseDates(calendar: readonly string[], planned: readonly string[]) {
  return [...new Set([...calendar, ...planned])].sort();
}
