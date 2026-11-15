import { describe, expect, it } from 'vitest';
import { newEvents, noticeText, pageOf, ruleOf, type PanelEvent } from './panelQueue';

const event = (seq: number, kind: PanelEvent['kind'] = 'notify', data: unknown = { text: `n${seq}` }): PanelEvent => ({ seq, kind, data, at: 0 });

describe('newEvents', () => {
  it('the first frame is only a starting point: nothing is replayed', () => {
    expect(newEvents(null, { seq: 3, events: [event(1), event(2), event(3)] })).toEqual({ cursor: 3, events: [] });
  });

  it('later frames give the events after the cursor, in order', () => {
    const result = newEvents(2, { seq: 5, events: [event(5), event(3), event(2), event(4)] });
    expect(result.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(result.cursor).toBe(5);
  });

  it('a frame with nothing new changes nothing', () => {
    expect(newEvents(5, { seq: 5, events: [event(5)] })).toEqual({ cursor: 5, events: [] });
  });

  it('a number that went back (the agent restarted) starts over without replaying', () => {
    expect(newEvents(40, { seq: 2, events: [event(1), event(2)] })).toEqual({ cursor: 2, events: [] });
  });
});

describe('noticeText and pageOf', () => {
  it('joins title and text, flattens white space and cuts a long line', () => {
    expect(noticeText({ title: 'CI', text: 'verde' })).toBe('📣 CI: verde');
    expect(noticeText({ title: '', text: 'a\n b' })).toBe('📣 a b');
    expect(noticeText({ text: 'x'.repeat(300) })).toHaveLength('📣 '.length + 160);
    expect(noticeText(null)).toBe('📣 ');
  });

  it('a rule is named by a non-empty text', () => {
    expect(ruleOf({ page: 'som', rule: 'tocando' })).toBe('tocando');
    for (const none of [null, {}, { rule: '' }, { rule: 3 }]) expect(ruleOf(none)).toBeNull();
  });

  it('only a plain page name is a page', () => {
    expect(pageOf({ page: 'som' })).toBe('som');
    expect(pageOf({ page: 'shortcuts-1' })).toBe('shortcuts-1');
    for (const bad of [null, {}, { page: 3 }, { page: 'A b' }, { page: '' }]) expect(pageOf(bad)).toBeNull();
  });
});
