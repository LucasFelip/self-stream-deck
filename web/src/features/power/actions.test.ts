import { describe, expect, it } from 'vitest';
import { ACTIONS, DELAYS, defaultDelay, isForced, summarize } from './actions';

const action = (id: string) => {
  const found = ACTIONS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no action ${id}`);
  return found;
};

describe('power actions', () => {
  it('has the eight actions in the order of the keys, and only the first runs without a sheet', () => {
    expect(ACTIONS.map((a) => a.id)).toEqual(['lock', 'sleep', 'hibernate', 'logoff', 'restart', 'shutdown', 'firmware', 'advanced']);
    expect(ACTIONS.filter((a) => a.immediate).map((a) => a.id)).toEqual(['lock']);
    // everything with a sheet explains itself
    for (const a of ACTIONS.filter((candidate) => !candidate.immediate)) {
      expect([a.title, a.effects, a.reconnect].every(Boolean)).toBe(true);
    }
  });

  it('only the restarts and the shutdown can be scheduled, and they start at 10 s; the rest run now', () => {
    expect(ACTIONS.filter((a) => a.delay).map((a) => a.id)).toEqual(['restart', 'shutdown', 'firmware', 'advanced']);
    expect(defaultDelay(action('shutdown'))).toBe(10);
    expect(defaultDelay(action('sleep'))).toBe(0);
  });

  it('a delay forces the apps to close (Windows rule), no delay leaves it to the person', () => {
    expect(isForced(false, 0)).toBe(false);
    expect(isForced(true, 0)).toBe(true);
    expect(isForced(false, 60)).toBe(true);
  });

  it('the summary says when and how', () => {
    expect(summarize(action('restart'), 0, false)).toBe('Reiniciar imediatamente.');
    expect(summarize(action('shutdown'), 60, true)).toBe('Desligar em 1 min (dá para cancelar até lá), fechando os apps à força.');
    expect(DELAYS[0]).toEqual(['Agora', 0]);
  });
});
