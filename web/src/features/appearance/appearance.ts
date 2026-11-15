// The look the person chose on this phone (menu > Aparência…): the accent color and the size of the text. Kept in localStorage (inside try/catch:
// without storage the choice lasts until the page reloads) and put on the page before it is drawn, so nothing flashes in the old colors.

export const ACCENTS = [
  { id: 'azul', label: 'Azul', hex: '#7c9cff' },
  { id: 'violeta', label: 'Violeta', hex: '#b197fc' },
  { id: 'verde', label: 'Verde', hex: '#4cc38a' },
  { id: 'ciano', label: 'Ciano', hex: '#2dd4bf' },
  { id: 'laranja', label: 'Laranja', hex: '#fb923c' },
  { id: 'rosa', label: 'Rosa', hex: '#f472b6' },
] as const;

export const SIZES = [
  { id: 'p', label: 'Pequeno', scale: 0.92 },
  { id: 'm', label: 'Normal', scale: 1 },
  { id: 'g', label: 'Grande', scale: 1.12 },
] as const;

export type AccentId = (typeof ACCENTS)[number]['id'];
export type SizeId = (typeof SIZES)[number]['id'];

export interface Look {
  accent: AccentId;
  size: SizeId;
}

export const DEFAULT_LOOK: Look = { accent: 'azul', size: 'm' };
const KEY = 'ssd.look';

/** A look from whatever was stored: anything that is not one of the known choices falls back to the default one by one. */
export function parseLook(text: string | null): Look {
  try {
    const raw = JSON.parse(text ?? '{}') as Partial<Record<keyof Look, unknown>>;
    return {
      accent: ACCENTS.find((a) => a.id === raw.accent)?.id ?? DEFAULT_LOOK.accent,
      size: SIZES.find((s) => s.id === raw.size)?.id ?? DEFAULT_LOOK.size,
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

export function readLook(): Look {
  try {
    return parseLook(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

export function saveLook(look: Look): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(look));
  } catch { /* no storage: it lasts until the page reloads */ }
}

/** `#rrggbb` as `r, g, b`, for `rgba(var(--accent-rgb), 0.2)`. */
export function rgbTriple(hex: string): string {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ');
}

/** Puts a look on the page: the accent (and its `r, g, b` form for the soft tints) and the text size. */
export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
  const accent = ACCENTS.find((a) => a.id === look.accent) ?? ACCENTS[0];
  const size = SIZES.find((s) => s.id === look.size) ?? SIZES[1];
  root.style.setProperty('--accent', accent.hex);
  root.style.setProperty('--accent-rgb', rgbTriple(accent.hex));
  root.style.fontSize = `${Math.round(size.scale * 100)}%`;
}
