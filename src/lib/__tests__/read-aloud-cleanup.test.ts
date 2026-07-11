import { describe, it, expect } from 'vitest';
import { cleanChunks } from '../read-aloud-cleanup';
import { needsModelCleanup } from '../content-chunker';

describe('read-aloud-cleanup', () => {
  describe('cleanChunks', () => {
    it('flags not-needed chunks as true (regression: original bug)', async () => {
      // This is the core regression: when no key, flagged chunks MUST still get true.
      const flagged = 'Price is £2.'; // needsModelCleanup false now (bare unit dropped, but imagine it was flagged)
      // Actually test with a truly flagged chunk
      const trulyFlagged = '• bullet point text';
      expect(needsModelCleanup(trulyFlagged)).toBe(true);

      const result = await cleanChunks([trulyFlagged], false, async () => 'cleaned');
      expect(result.cleanedFlags[0]).toBe(true);
      expect(result.chunks[0]).toBe(trulyFlagged); // raw kept (no key)
    });

    it('flags everything true when no key even for flagged chunks', async () => {
      const chunks = ['• one', '• two', '• three', 'degrees Celsius'];
      const result = await cleanChunks(chunks, false, async () => 'cleaned');
      expect(result.cleanedFlags.every((f) => f)).toBe(true);
      expect(result.chunks).toEqual(chunks);
    });

    it('counts 50 flagged chunks as all true when no key', async () => {
      const chunks = Array.from({ length: 50 }, (_, i) => `• bullet ${i}`);
      const result = await cleanChunks(chunks, false, async () => 'cleaned');
      const falseCount = result.cleanedFlags.filter((f) => !f).length;
      expect(falseCount).toBe(0);
    });

    it('flags false on real cleanup failure, keeps raw (never drop)', async () => {
      const raw = '• bullet point';
      const failingClean = async () => {
        throw new Error('Auth failed');
      };

      const result = await cleanChunks([raw], true, failingClean);
      expect(result.cleanedFlags[0]).toBe(false);
      expect(result.chunks[0]).toBe(raw); // raw preserved
    });

    it('keeps raw when cleanup returns empty (exposes F2 guard)', async () => {
      const raw = '• bullet point text here';
      // Clean returns empty string — guard should keep raw.
      const emptyClean = async () => '';

      const result = await cleanChunks([raw], true, emptyClean);
      expect(result.cleanedFlags[0]).toBe(true); // guard treats empty as success
      expect(result.chunks[0]).toBe(raw); // raw kept, not dropped
    });

    it('treats whitespace-only cleanup as kept raw (guard check)', async () => {
      const raw = '• bullet point';
      const whitespaceClean = async () => '   ';

      const result = await cleanChunks([raw], true, whitespaceClean);
      expect(result.cleanedFlags[0]).toBe(true);
      expect(result.chunks[0]).toBe(raw);
    });

    it('returns cleaned text and true flag on success', async () => {
      const raw = '• bullet point';
      const cleaned = 'Bullet point';
      const successClean = async () => cleaned;

      const result = await cleanChunks([raw], true, successClean);
      expect(result.cleanedFlags[0]).toBe(true);
      expect(result.chunks[0]).toBe(cleaned);
    });

    it('handles mixed success/failure across chunks', async () => {
      const raw1 = '• flagged'; // needs cleanup
      const raw2 = 'normal paragraph'; // no cleanup needed
      const raw3 = 'degrees Celsius'; // needs cleanup

      const mixedClean = async (c: string) => {
        if (c.includes('flagged')) throw new Error('fail');
        return c;
      };

      const result = await cleanChunks([raw1, raw2, raw3], true, mixedClean);
      expect(result.cleanedFlags).toEqual([false, true, true]);
      expect(result.chunks).toEqual([raw1, raw2, raw3]); // only raw1 kept raw
    });
  });
});