export const randomDelay = () => {
  const ms = Math.floor(Math.random() * 900) + 100;
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export function isWithinTimeWindow(
  utcDateStr: string,
  weekdayThresholds: [number, number],
  weekendThresholds: [number, number],
): boolean {
  const dateObj = new Date(utcDateStr);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(dateObj);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);

  if (weekday === "Sat" || weekday === "Sun") {
    return hour >= weekendThresholds[0] && hour <= weekendThresholds[1];
  }
  return hour >= weekdayThresholds[0] && hour <= weekdayThresholds[1];
}

export function buildMarkdownList(entries: any[]): string {
  if (entries.length === 0) return "";
  entries.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  const byDate = new Map<string, any[]>();
  for (const entry of entries) {
    if (!byDate.has(entry.dateStr)) byDate.set(entry.dateStr, []);
    byDate.get(entry.dateStr)!.push(entry);
  }

  let text = "";
  for (const [date, slots] of byDate.entries()) {
    text += `- ${date}\n`;
    for (const slot of slots) {
      const sortedDurations = slot.durations.sort((a: number, b: number) =>
        a - b
      ).join(", ");
      text +=
        `  - ${slot.courtName}: ${slot.timeStr} (${sortedDurations} Min)\n`;
    }
  }
  return text.trim();
}
