import type { components } from '../../api/schema';

type App = components['schemas']['App'];
type Shortcut = components['schemas']['Shortcut'];
type MacroSummary = components['schemas']['MacroSummary'];

/**
 * A key of the Apps or Atalhos page: what it is, how it is named and how it is found again. `key` is the stable name the layout
 * saves ("a:<app>", "s:<shortcut>", "m:<macro>").
 */
export type DeckItem =
  | { kind: 'app'; key: string; id: string; label: string; hasIcon: boolean; iconVersion: string }
  | { kind: 'shortcut'; key: string; id: string; label: string; display: string }
  | { kind: 'macro'; key: string; id: string; label: string; steps: number }
  | { kind: 'camera'; key: string; id: 'camera'; label: string };

export const appItem = (app: App): DeckItem => ({ kind: 'app', key: `a:${app.id}`, id: app.id, label: app.name, hasIcon: app.hasIcon, iconVersion: app.iconVersion });
export const shortcutItem = (shortcut: Shortcut): DeckItem => ({ kind: 'shortcut', key: `s:${shortcut.id}`, id: shortcut.id, label: shortcut.label, display: shortcut.display });
export const macroItem = (macro: MacroSummary): DeckItem => ({ kind: 'macro', key: `m:${macro.id}`, id: macro.id, label: macro.label, steps: macro.steps });

/** The phone camera as the PC webcam is one more key on the Apps page: a tap turns it on or off. */
export const cameraItem = (): DeckItem => ({ kind: 'camera', key: 'c:camera', id: 'camera', label: 'Câmera' });

/** The keys of the Apps page: the taskbar apps, the macros placed on it and the camera. */
export const appsKeys = (apps: readonly App[], macros: readonly MacroSummary[]): DeckItem[] => [...apps.map(appItem), ...macros.filter((macro) => macro.page === 'apps').map(macroItem), cameraItem()];

/** The keys of the Atalhos page: the shortcuts, then the macros that are not on Apps. */
export const shortcutKeys = (shortcuts: readonly Shortcut[], macros: readonly MacroSummary[]): DeckItem[] => [...shortcuts.map(shortcutItem), ...macros.filter((macro) => macro.page !== 'apps').map(macroItem)];

/** "Copiar" shows its key combination as "Ctrl+C", with room to break the line after each "+". */
export const keycapText = (display: string): string => display.replace(/\+/g, '+​');
