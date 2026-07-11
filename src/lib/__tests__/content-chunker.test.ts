import { describe, it, expect, afterEach } from 'vitest';
import { needsModelCleanup, detectLocale, chunkForRead } from '../content-chunker';

describe('content-chunker', () => {
  // needsModelCleanup — adversarial / unhappy cases
  describe('needsModelCleanup', () => {
    it('returns false for empty string', () => {
      expect(needsModelCleanup('')).toBe(false);
    });

    it('returns false for whitespace-only', () => {
      expect(needsModelCleanup('   \n  ')).toBe(false);
    });

    it('returns false for plain English (no symbols)', () => {
      expect(needsModelCleanup('The cat sat on the mat and watched the rain.')).toBe(false);
    });

    it('returns false for bare decimal (3.14 dropped)', () => {
      // Spelled units like "meters" ARE flagged; but bare decimal alone is not.
      expect(needsModelCleanup('3.14')).toBe(false);
    });

    it('returns false for bare currency and unit (£2, 5 m)', () => {
      expect(needsModelCleanup('Price is £2 and 5 m long.')).toBe(false);
    });

    it('returns false for bare degree glyph (5°C)', () => {
      expect(needsModelCleanup('Temp 5°C today.')).toBe(false);
    });

    it('returns false for standalone bare unit km', () => {
      expect(needsModelCleanup('km')).toBe(false);
    });

    it('returns true for bullet glyph', () => {
      expect(needsModelCleanup('• one\n• two')).toBe(true);
    });

    it('returns true for math symbols', () => {
      expect(needsModelCleanup('∑x = 0')).toBe(true);
    });

    it('returns true for spelled-out units', () => {
      expect(needsModelCleanup('10 degrees outside')).toBe(true);
    });

    it('returns true for emoji', () => {
      expect(needsModelCleanup('Launch 🚀 now')).toBe(true);
    });

    it('returns true for non-breaking space', () => {
      expect(needsModelCleanup('\u00a0')).toBe(true);
    });
  });

  // detectLocale — unhappy cases
  describe('detectLocale', () => {
    it('returns en for null document', () => {
      expect(detectLocale(null)).toBe('en');
    });

    it('returns en for undefined', () => {
      expect(detectLocale(undefined)).toBe('en');
    });

    it('returns lowercase primary tag (EN-US -> en)', () => {
      const doc = {
        documentElement: { getAttribute: () => 'EN-US' },
      } as unknown as Document;
      expect(detectLocale(doc)).toBe('en');
    });

    it('returns en for missing lang attribute', () => {
      const doc = {
        documentElement: { getAttribute: () => null },
      } as unknown as Document;
      expect(detectLocale(doc)).toBe('en');
    });

    it('strips region suffix (fr-CA -> fr)', () => {
      const doc = {
        documentElement: { getAttribute: () => 'fr-CA' },
      } as unknown as Document;
      expect(detectLocale(doc)).toBe('fr');
    });
  });

  // chunkForRead — unhappy cases
  describe('chunkForRead', () => {
    it('returns empty array for empty prose', () => {
      expect(chunkForRead('')).toEqual([]);
    });

    it('returns single chunk for no sentence boundaries', () => {
      const prose = 'ThisIsOneGiantRunOnSentenceWithNoTerminalPunctuationAtAll';
      const chunks = chunkForRead(prose);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toContain('GiantRunOn');
    });

    it('does not throw for unsupported locale', () => {
      expect(() => chunkForRead('Hello world. Goodbye.', { locale: 'zz' })).not.toThrow();
      const chunks = chunkForRead('Hello world. Goodbye.', { locale: 'zz' });
      expect(Array.isArray(chunks)).toBe(true);
    });

    it('preserves all sentences in output', () => {
      const prose = 'First sentence. Second sentence. Third sentence.';
      const chunks = chunkForRead(prose);
      const combined = chunks.join(' ');
      expect(combined).toContain('First sentence');
      expect(combined).toContain('Second sentence');
      expect(combined).toContain('Third sentence');
    });
  });
});