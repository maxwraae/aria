import { describe, it, expect } from 'vitest';
import { countTokens } from './tokens.js';

describe('countTokens', () => {
  it('counts empty string as 0', () => {
    expect(countTokens('')).toBe(0);
  });

  it('rounds up partial tokens', () => {
    expect(countTokens('abc')).toBe(1);  // 3/4 = 0.75, ceil = 1
  });

  it('exact multiple returns exact count', () => {
    expect(countTokens('abcd')).toBe(1);  // 4/4 = 1
  });

  it('handles longer text', () => {
    const text = 'a'.repeat(100);
    expect(countTokens(text)).toBe(25);  // 100/4 = 25
  });

  it('handles text with newlines and special chars', () => {
    const text = 'Hello\nWorld!\n# Header\n';
    expect(countTokens(text)).toBe(Math.ceil(text.length / 4));
  });
});
