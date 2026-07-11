import { describe, it, expect } from 'vitest';
import { normalizeProse } from '../prose-normalizer';

describe('prose-normalizer', () => {
  it('empty string returns empty', () => {
    const result = normalizeProse('');
    expect(result.prose).toBe('');
    expect(result.lineCount).toBe(0);
  });

  it('whitespace-only returns empty', () => {
    const result = normalizeProse('   \n\n   \t   ');
    expect(result.prose).toBe('');
    expect(result.lineCount).toBe(0);
  });

  it('collapses internal whitespace', () => {
    const result = normalizeProse('First  line   with   spaces.\n\nSecond\tline.');
    expect(result.prose).toBe('First line with spaces.\n\nSecond line.');
    expect(result.lineCount).toBe(2);
  });

  it('never invents labels — output is substring of input', () => {
    const raw = 'Weight: 150g\nBattery: 8 hours\nRAM: 16GB';
    const result = normalizeProse(raw);
    expect(result.prose).toContain('Weight');
    expect(result.prose).toContain('Battery');
    expect(result.prose).toContain('150g');
    // Output must not contain anything not in raw
    expect(result.prose).not.toMatch(/\bHours\b/);
  });
});