/**
 * Phase K: Tests for LINK_SELECT logic
 */
import { describe, it, expect } from 'vitest';
import { parseLinkSelectResponse } from '../link-select';

const mockLinks = [
  { index: 1, text: 'Privacy Policy', heading: 'Legal', href: '/privacy' },
  { index: 2, text: 'Contact Us', heading: 'Support', href: '/contact' },
  { index: 3, text: 'Sports News', heading: 'News', href: '/sports' },
];

describe('parseLinkSelectResponse', () => {
  it('navigates when LLM returns a valid index', () => {
    const raw = '{"action":"navigate","index":2}';
    const result = parseLinkSelectResponse(raw, mockLinks);
    expect(result.action).toBe('navigate');
    expect(result.url).toBe('/contact');
  });

  it('collision returns candidates list', () => {
    const raw = '{"action":"collision","candidates":[1,3],"message":"Several options match."}';
    const result = parseLinkSelectResponse(raw, mockLinks);
    expect(result.action).toBe('collision');
    expect(result.candidates).toHaveLength(2);
    expect(result.message).toBe('Several options match.');
  });

  it('none returns speech', () => {
    const raw = '{"action":"none","speech":"No match found."}';
    const result = parseLinkSelectResponse(raw, mockLinks);
    expect(result.action).toBe('none');
    expect(result.speech).toBe('No match found.');
  });

  it('invalid JSON returns none', () => {
    const result = parseLinkSelectResponse('not json', mockLinks);
    expect(result.action).toBe('none');
  });

  it('out-of-range index returns none', () => {
    const raw = '{"action":"navigate","index":99}';
    const result = parseLinkSelectResponse(raw, mockLinks);
    expect(result.action).toBe('none');
    expect(result.url).toBeUndefined();
  });

  it('handles code-fenced JSON', () => {
    const raw = '```json\n{"action":"navigate","index":1}\n```';
    const result = parseLinkSelectResponse(raw, mockLinks);
    expect(result.action).toBe('navigate');
    expect(result.url).toBe('/privacy');
  });
});