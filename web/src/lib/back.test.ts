import { describe, expect, it } from 'vitest';
import { registerBack, runBack } from './back';

describe('the Back stack', () => {
  it('undoes the newest thing first, one per call, and says false when nothing is left', () => {
    const undone: string[] = [];
    const offA = registerBack(() => { undone.push('a'); return true; });
    const offB = registerBack(() => { undone.push('b'); return true; });
    expect(runBack()).toBe(true);
    expect(undone).toEqual(['b']);
    offB();
    expect(runBack()).toBe(true);
    expect(undone).toEqual(['b', 'a']);
    offA();
    expect(runBack()).toBe(false);
  });

  it('a handler that has nothing to undo passes the press to the next one', () => {
    const calls: string[] = [];
    const off1 = registerBack(() => { calls.push('page'); return true; });
    const off2 = registerBack(() => { calls.push('menu'); return false; });
    expect(runBack()).toBe(true);
    expect(calls).toEqual(['menu', 'page']);
    off1();
    off2();
  });
});
