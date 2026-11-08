import type { components } from '../../api/schema';

export type EditorData = components['schemas']['EditorData'];
export type MacroStep = components['schemas']['MacroStep'];
export type EditorApp = components['schemas']['EditorApp'];

/** A shortcut or a macro as the editor holds it: the ones that are new have no id yet (the PC gives it when saved). */
export interface ShortcutDraft { id?: string; label: string; keys: string }
export interface MacroDraft { id?: string; label: string; page: 'shortcuts' | 'apps'; steps: MacroStep[] }

export type Tab = 'shortcuts' | 'macros' | 'apps';
export const TABS: ReadonlyArray<readonly [Tab, string]> = [['shortcuts', 'Atalhos'], ['macros', 'Macros'], ['apps', 'Apps']];

export const MODS = [['ctrl', 'Ctrl'], ['shift', 'Shift'], ['alt', 'Alt'], ['win', 'Win']] as const;
export const MEDIA = [['playpause', 'Play / pausa'], ['next', 'Próxima faixa'], ['prev', 'Faixa anterior']] as const;
export const MUTE = [[true, 'Silenciar'], [false, 'Ativar o som'], ['toggle', 'Alternar']] as const;
export const ZONES = [['left', 'Metade esquerda'], ['right', 'Metade direita'], ['full', 'Tela cheia']] as const;
export const WAITS = [[500, '0,5 s'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s'], [5000, '5 s'], [10000, '10 s']] as const;
export const ARM_MS = 3000;

const modNames: readonly string[] = MODS.map(([mod]) => mod);
const normalize = (token: string): string => (token === 'control' ? 'ctrl' : token);

/** "ctrl+shift+m" -> the modifiers that are on and the key. */
export function parseKeys(spec: string): { mods: string[]; key: string } {
  const tokens = String(spec || '').toLowerCase().split('+').map((token) => token.trim()).filter(Boolean);
  const mods = new Set(tokens.map(normalize).filter((token) => modNames.includes(token)));
  const key = tokens.filter((token) => !modNames.includes(normalize(token))).join('+');
  return { mods: modNames.filter((mod) => mods.has(mod)), key };
}

/** The modifiers in the order Ctrl, Shift, Alt, Win, then the key. */
export function composeKeys(mods: readonly string[], key: string): string {
  return [...modNames.filter((mod) => mods.includes(mod)), key].filter(Boolean).join('+');
}

/** "Aperta: Ctrl + Shift + M" (a single letter or an F-key in capitals), or nothing without keys. */
export function describeKeys(spec: string): string {
  if (!spec) return '';
  const words = spec.split('+').map((token) => (token.length === 1 || /^f\d+$/.test(token) ? token.toUpperCase() : `${token.charAt(0).toUpperCase()}${token.slice(1)}`));
  return `Aperta: ${words.join(' + ')}`;
}

export const stepWord = (count: number): string => `${count} passo${count === 1 ? '' : 's'}`;

export const STEP_TYPES: ReadonlyArray<readonly [MacroStep['type'], string]> = [
  ['launch', 'Abrir ou focar um app'],
  ['place', 'Posicionar a janela de um app'],
  ['keys', 'Pressionar teclas'],
  ['media', 'Tecla de mídia'],
  ['volume', 'Definir o volume'],
  ['mute', 'Mudo do som'],
  ['mic', 'Mudo do microfone'],
  ['output', 'Trocar a saída/entrada de áudio'],
  ['wait', 'Esperar'],
  ['camera', 'Câmera do celular'],
];

/** A new step of that type, with a sensible first choice taken from what the PC has (apps, audio devices). */
export function makeStep(type: MacroStep['type'], data: Pick<EditorData, 'apps' | 'devices'>): MacroStep {
  switch (type) {
    case 'launch': return { type: 'launch', app: data.apps[0]?.id ?? '' };
    case 'place': return { type: 'place', app: (data.apps.find((app) => app.canPlace) ?? data.apps[0])?.id ?? '', monitor: 0, zone: 'left' };
    case 'keys': return { type: 'keys', keys: 'ctrl+shift+m' };
    case 'media': return { type: 'media', key: 'playpause' };
    case 'volume': return { type: 'volume', level: 50 };
    case 'mute': return { type: 'mute', muted: 'toggle' };
    case 'mic': return { type: 'mic', muted: 'toggle' };
    case 'output': {
      const device = data.devices.playback[0] ?? data.devices.capture[0] ?? { id: '', name: '' };
      return { type: 'output', device: device.id, name: device.name };
    }
    case 'camera': return { type: 'camera', on: true };
    default: return { type: 'wait', ms: 1000 };
  }
}

/** Moves the item at `index` by `by` places; the list as it was if that would leave it. */
export function moveItem<T>(list: readonly T[], index: number, by: number): T[] {
  const to = index + by;
  const next = [...list];
  if (to < 0 || to >= next.length) return next;
  const a = next[index] as T;
  next[index] = next[to] as T;
  next[to] = a;
  return next;
}

/** Where the editor opens when edit mode taps a key ("a:<app>", "s:<shortcut>", "m:<macro>") or a "+" slot of a page. */
export type Target = { key: string } | { create: 'apps' | 'shortcuts' } | null;

export function tabFor(target: Target, lists: { shortcuts: readonly { id?: string }[]; macros: readonly { id?: string }[] }): { tab: Tab; selected?: number } {
  if (!target) return { tab: 'shortcuts' };
  if ('create' in target) return { tab: target.create === 'apps' ? 'macros' : 'shortcuts' };
  const kind = target.key.charAt(0);
  const id = target.key.slice(2);
  if (kind === 's') return { tab: 'shortcuts', selected: Math.max(0, lists.shortcuts.findIndex((item) => item.id === id)) };
  if (kind === 'm') return { tab: 'macros', selected: Math.max(0, lists.macros.findIndex((item) => item.id === id)) };
  return { tab: 'apps' };
}
