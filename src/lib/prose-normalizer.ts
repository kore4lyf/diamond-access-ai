/**
 * Diamond Access AI — Prose normalizer
 *
 * Shared change 1: Normalizes raw textContent/innerText into clean lines
 * for TTS and chunking. Guarantees no label invention.
 */

export function normalizeProse(raw: string): { prose: string; lineCount: number } {
  if (!raw || !raw.trim()) {
    return { prose: '', lineCount: 0 };
  }

  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const prose = lines.join('\n\n');
  const lineCount = lines.length;

  return { prose, lineCount };
}