import { describe, expect, it } from 'bun:test';
import { parseStatStartTime, processStartTime } from './owner-tag';

/** A /proc/<pid>/stat line: pid, comm, then fields 3..52, with field 22 set to `start`. */
function statLine(comm: string, start: number): string {
  const rest: string[] = [];
  for (let n = 3; n <= 52; n++) rest.push(n === 22 ? String(start) : String(n * 1000));
  return `4242 ${comm} ${rest.join(' ')}\n`;
}

describe('parseStatStartTime', () => {
  it('extracts field 22 when comm contains spaces and parentheses', () => {
    expect(parseStatStartTime(statLine('(a b) (c))', 987654321))).toBe(987654321);
  });

  it('extracts field 22 for a normal comm', () => {
    expect(parseStatStartTime(statLine('(bun)', 123456))).toBe(123456);
  });

  it('is undefined for a truncated stat line', () => {
    expect(parseStatStartTime('4242 (bun) S 1 2 3')).toBeUndefined();
  });

  it('is undefined for a line with no closing parenthesis', () => {
    expect(parseStatStartTime('garbage')).toBeUndefined();
  });
});

describe('processStartTime smoke', () => {
  it('is a stable number for this process', () => {
    const a = processStartTime(process.pid);
    expect(typeof a).toBe('number');
    expect(processStartTime(process.pid)).toBe(a);
  });

  it('is undefined for a pid that does not exist', () => {
    expect(processStartTime(2 ** 22 + 12345)).toBeUndefined();
  });
});
