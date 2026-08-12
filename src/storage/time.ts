const TZ = 'Europe/Moscow';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function nowIso(): string {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}+03:00`;
}

export function todayCompact(): string {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

export function nowCompactTimestamp(): string {
  const date = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

export function daysOld(iso?: string): number {
  if (!iso) {
    return 0;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return Math.floor((Date.now() - parsed) / (24 * 60 * 60 * 1000));
}

export function todayArchiveYear(): string {
  const compact = todayCompact();
  return compact.slice(0, 4);
}

export function durationToDays(raw: string): number {
  const match = /^(\d+)\s*d$/i.exec(raw.trim());
  return match ? Number(match[1]) : 0;
}

export function dateFromCompact(date: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

export function suffix(count: number): string {
  return pad(count).padStart(3, '0');
}
