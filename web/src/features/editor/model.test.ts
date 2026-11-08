import { describe, expect, it } from 'vitest';
import { composeKeys, describeKeys, makeStep, moveItem, parseKeys, stepWord, tabFor } from './model';

describe('key specs', () => {
  it('parseKeys: modifiers in a fixed order, the rest is the key, "control" is "ctrl"', () => {
    expect(parseKeys('shift+ctrl+m')).toEqual({ mods: ['ctrl', 'shift'], key: 'm' });
    expect(parseKeys('Control + Alt + F5')).toEqual({ mods: ['ctrl', 'alt'], key: 'f5' });
    expect(parseKeys('')).toEqual({ mods: [], key: '' });
    expect(parseKeys('win+left')).toEqual({ mods: ['win'], key: 'left' });
  });

  it('composeKeys: Ctrl, Shift, Alt, Win, then the key; an empty key leaves only the modifiers', () => {
    expect(composeKeys(['win', 'ctrl'], 'e')).toBe('ctrl+win+e');
    expect(composeKeys(['shift'], '')).toBe('shift');
    expect(composeKeys([], 'esc')).toBe('esc');
  });

  it('describeKeys: a letter or an F-key in capitals, other keys capitalised', () => {
    expect(describeKeys('ctrl+shift+m')).toBe('Aperta: Ctrl + Shift + M');
    expect(describeKeys('alt+f4')).toBe('Aperta: Alt + F4');
    expect(describeKeys('win+left')).toBe('Aperta: Win + Left');
    expect(describeKeys('')).toBe('');
  });
});

describe('steps', () => {
  const data = {
    apps: [{ id: 'a1', name: 'Um', hasIcon: false, iconVersion: '', hidden: false, canPlace: false }, { id: 'a2', name: 'Dois', hasIcon: false, iconVersion: '', hidden: false, canPlace: true }],
    devices: { playback: [{ id: 'p1', name: 'Alto-falantes' }], capture: [{ id: 'c1', name: 'Microfone' }] },
  };

  it('a new step starts with something the PC has', () => {
    expect(makeStep('launch', data)).toEqual({ type: 'launch', app: 'a1' });
    expect(makeStep('place', data)).toEqual({ type: 'place', app: 'a2', monitor: 0, zone: 'left' }); // an app whose window can be found
    expect(makeStep('output', data)).toEqual({ type: 'output', device: 'p1', name: 'Alto-falantes' });
    expect(makeStep('output', { ...data, devices: { playback: [], capture: [{ id: 'c1', name: 'Microfone' }] } })).toEqual({ type: 'output', device: 'c1', name: 'Microfone' });
    expect(makeStep('launch', { ...data, apps: [] })).toEqual({ type: 'launch', app: '' });
    expect(makeStep('wait', data)).toEqual({ type: 'wait', ms: 1000 });
    expect(makeStep('camera', data)).toEqual({ type: 'camera', on: true });
  });

  it('moveItem swaps with the neighbour and stays put at the ends', () => {
    expect(moveItem([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 1, 1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });

  it('stepWord', () => {
    expect(stepWord(1)).toBe('1 passo');
    expect(stepWord(3)).toBe('3 passos');
  });
});

describe('where the editor opens', () => {
  const lists = { shortcuts: [{ id: 'copy' }, { id: 'paste' }], macros: [{ id: 'foco' }] };

  it('a tapped key selects its row on its tab', () => {
    expect(tabFor({ key: 's:paste' }, lists)).toEqual({ tab: 'shortcuts', selected: 1 });
    expect(tabFor({ key: 'm:foco' }, lists)).toEqual({ tab: 'macros', selected: 0 });
    expect(tabFor({ key: 'a:app0' }, lists)).toEqual({ tab: 'apps' });
    expect(tabFor({ key: 's:gone' }, lists)).toEqual({ tab: 'shortcuts', selected: 0 });
  });

  it('a "+" slot starts a new item: a macro on Apps, a shortcut on Atalhos', () => {
    expect(tabFor({ create: 'apps' }, lists)).toEqual({ tab: 'macros' });
    expect(tabFor({ create: 'shortcuts' }, lists)).toEqual({ tab: 'shortcuts' });
    expect(tabFor(null, lists)).toEqual({ tab: 'shortcuts' });
  });
});
