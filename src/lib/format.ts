export function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtGB(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)} PB`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)} TB`;
  return `${Math.round(n)} GB`;
}

export function fmtMs(n: number): string {
  return n < 10 ? `${n.toFixed(1)} ms` : `${Math.round(n)} ms`;
}
