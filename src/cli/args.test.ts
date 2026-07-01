import { describe, it, expect } from 'vitest';
import { parseArgs, listFlag, numberFlag } from './args';

describe('parseArgs', () => {
  it('parses command, positional input, and value flags', () => {
    const a = parseArgs(['sanitize', 'file.log', '--bridge', 'case.cloak', '--mode', 'token']);
    expect(a.command).toBe('sanitize');
    expect(a.input).toBe('file.log');
    expect(a.flags['bridge']).toBe('case.cloak');
    expect(a.flags['mode']).toBe('token');
  });

  it('supports --flag=value form', () => {
    const a = parseArgs(['restore', '--bridge=case.cloak']);
    expect(a.flags['bridge']).toBe('case.cloak');
  });

  it('treats known boolean flags as true without consuming the next token', () => {
    const a = parseArgs(['sanitize', 'f', '--audit', '--bridge', 'b']);
    expect(a.flags['audit']).toBe(true);
    expect(a.flags['bridge']).toBe('b');
  });

  it('reads "-" as the stdin sentinel, not a positional', () => {
    const a = parseArgs(['scan', '-']);
    expect(a.input).toBe('-');
  });

  it('defaults to the help command when argv is empty', () => {
    expect(parseArgs([]).command).toBe('help');
  });
});

describe('flag coercion', () => {
  it('listFlag splits, trims, and drops blanks', () => {
    expect(listFlag('IPV4, EMAIL ,, SSN')).toEqual(['IPV4', 'EMAIL', 'SSN']);
    expect(listFlag(true)).toBeUndefined();
    expect(listFlag(undefined)).toBeUndefined();
  });

  it('numberFlag parses finite numbers only', () => {
    expect(numberFlag('0.6')).toBe(0.6);
    expect(numberFlag('nope')).toBeUndefined();
    expect(numberFlag(true)).toBeUndefined();
  });
});
