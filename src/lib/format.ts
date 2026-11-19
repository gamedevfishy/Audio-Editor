/** 83.456 -> "1:23.46" (digits = 2) or "1:23.456" (digits = 3) */
export function formatTime(sec: number, digits = 2): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const scale = Math.pow(10, digits);
  const rounded = Math.round(sec * scale) / scale;
  const m = Math.floor(rounded / 60);
  const s = rounded - m * 60;
  return `${m}:${s.toFixed(digits).padStart(digits + 3, '0')}`;
}

/** Accepts "83.4", "1:23.4" or "0:01:23.4". Returns null when unparsable. */
export function parseTime(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => Number(p));
  if (parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDb(db: number): string {
  if (db === 0) return '0 dB';
  return `${db > 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`;
}

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function baseName(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}
