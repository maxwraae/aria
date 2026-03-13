/**
 * Parse a human-friendly interval string into seconds.
 * Supports: 5s, 1m, 1h, 1d (and combinations are not supported — single unit only).
 * Returns null if the string is invalid.
 */
export function parseInterval(str: string): number | null {
  const match = str.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return null;
  }
}
