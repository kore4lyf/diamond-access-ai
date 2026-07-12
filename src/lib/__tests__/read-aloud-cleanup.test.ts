import { describe, it, expect } from 'vitest';
import { cleanChunks } from '../read-aloud-cleanup';
import { needsModelCleanup } from '../content-chunker';

describe('read-aloud-cleanup', () => {
  describe('cleanChunks', () => {
    // Flag semantics: false = cleaned (LLM modified), true = raw (skipped or failed)

    it('no key: all chunks kept raw, noKeyCount matches', async () => {
      const chunks = ['• one', '• two', '• three'];
      const result = await cleanChunks(chunks, false, async () => 'cleaned');
      expect(result.cleanedFlags).toEqual([true, true, true]);
      expect(result.chunks).toEqual(chunks);
      expect(result.noKeyCount).toBe(3);
    });

    it('no key: flagged chunk stays raw, noKeyCount=1', async () => {
      const flagged = '• bullet point text';
      expect(needsModelCleanup(flagged)).toBe(true);
      const result = await cleanChunks([flagged], false, async () => 'cleaned');
      expect(result.cleanedFlags[0]).toBe(true);
      expect(result.chunks[0]).toBe(flagged);
      expect(result.noKeyCount).toBe(1);
    });

    it('cleanup failure: flag=true (raw), noKeyCount=0', async () => {
      const raw = '• bullet point';
      const failingClean = async () => { throw new Error('Auth failed'); };
      const result = await cleanChunks([raw], true, failingClean);
      expect(result.cleanedFlags[0]).toBe(true);  // raw — failed
      expect(result.chunks[0]).toBe(raw);
      expect(result.noKeyCount).toBe(0);
    });

    it('empty cleanup return: guard keeps raw, flag=true', async () => {
      const raw = '• bullet point text here';
      const result = await cleanChunks([raw], true, async () => '');
      expect(result.cleanedFlags[0]).toBe(true);  // raw — empty guard
      expect(result.chunks[0]).toBe(raw);
    });

    it('whitespace-only cleanup: guard keeps raw', async () => {
      const raw = '• bullet point';
      const result = await cleanChunks([raw], true, async () => '   ');
      expect(result.cleanedFlags[0]).toBe(true);
      expect(result.chunks[0]).toBe(raw);
    });

    it('successful cleanup: flag=false (cleaned)', async () => {
      const raw = '• bullet point';
      const cleaned = 'Bullet point';
      const result = await cleanChunks([raw], true, async () => cleaned);
      expect(result.cleanedFlags[0]).toBe(false);  // cleaned by LLM
      expect(result.chunks[0]).toBe(cleaned);
      expect(result.noKeyCount).toBe(0);
    });

    it('mixed: cleaned, no-cleanup-needed, failed', async () => {
      const raw1 = '• flagged';       // needs cleanup → cleaned
      const raw2 = 'normal paragraph'; // no cleanup needed → raw
      const raw3 = '• broken';         // needs cleanup → fails → raw

      const mixedClean = async (c: string) => {
        if (c.includes('broken')) throw new Error('fail');
        return `cleaned: ${c}`;
      };

      const result = await cleanChunks([raw1, raw2, raw3], true, mixedClean);
      // raw1: cleaned → false, raw2: no-cleanup-needed → true, raw3: failed → true
      expect(result.cleanedFlags).toEqual([false, true, true]);
      expect(result.chunks).toEqual(['cleaned: • flagged', 'normal paragraph', '• broken']);
      expect(result.noKeyCount).toBe(0);
    });

    it('no key + mixed flagged/unflagged: noKeyCount only counts chunks', async () => {
      const chunks = ['• flagged', 'plain text', '• another flagged'];
      const result = await cleanChunks(chunks, false, async () => 'cleaned');
      expect(result.cleanedFlags).toEqual([true, true, true]);
      expect(result.noKeyCount).toBe(3); // all 3 kept raw due to no key
    });
  });
});