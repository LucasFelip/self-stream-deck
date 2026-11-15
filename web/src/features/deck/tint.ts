import { useEffect, useState } from 'react';

/** The tone of a key: its own color at a low strength behind the icon, so a row of keys reads by color before it reads by shape. */
export type Rgb = readonly [number, number, number];

const SAMPLE = 16;

/**
 * The color an icon is mostly made of, from its RGBA pixels. Transparent, nearly black, nearly white and gray pixels do not vote (a gray
 * logo has no color to give); the rest vote with their saturation, so a small bright part beats a large dull one. `null` when nothing votes.
 */
export function dominant(pixels: ArrayLike<number>): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const [pr, pg, pb, pa] = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!, pixels[i + 3]!];
    if (pa < 128) continue;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    if (max < 40 || min > 225) continue;
    const saturation = max === 0 ? 0 : (max - min) / max;
    if (saturation < 0.25) continue;
    r += pr * saturation;
    g += pg * saturation;
    b += pb * saturation;
    weight += saturation;
  }
  if (weight === 0) return null;
  return [Math.round(r / weight), Math.round(g / weight), Math.round(b / weight)];
}

/** A steady, muted color made from a text (for the keys that have no icon): the same text gives the same color on every phone. */
export function colorOf(text: string): Rgb {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const [s, l] = [0.5, 0.55];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const cache = new Map<string, Promise<Rgb | null>>();

/** The dominant color of the image at `src` (same origin), read once; `null` where there is no canvas or no color. */
export function tintOf(src: string): Promise<Rgb | null> {
  let found = cache.get(src);
  if (!found) {
    found = new Promise<Rgb | null>((resolve) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = SAMPLE;
          canvas.height = SAMPLE;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) { resolve(null); return; }
          context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
          resolve(dominant(context.getImageData(0, 0, SAMPLE, SAMPLE).data));
        } catch {
          resolve(null); // a canvas that cannot be read (no canvas, or an image from elsewhere)
        }
      };
      image.onerror = () => resolve(null);
      image.src = src;
    });
    cache.set(src, found);
  }
  return found;
}

/** `r, g, b` for `rgba(var(--tint), 0.2)`. */
export const triple = (rgb: Rgb): string => rgb.join(', ');

/** The tone of a key: from its icon when it has one, else from its name; `null` for a key that keeps the plain look. */
export function useTint(src: string | null, fallbackText: string | null): string | null {
  const [fromIcon, setFromIcon] = useState<Rgb | null>(null);
  useEffect(() => {
    if (!src) { setFromIcon(null); return undefined; }
    let alive = true;
    void tintOf(src).then((rgb) => { if (alive) setFromIcon(rgb); });
    return () => { alive = false; };
  }, [src]);
  const rgb = fromIcon ?? (fallbackText ? colorOf(fallbackText) : null);
  return rgb ? triple(rgb) : null;
}
