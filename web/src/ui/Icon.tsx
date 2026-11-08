import type { CSSProperties } from 'react';
import { FLUENT, ICONS } from './iconData';

interface IconProps {
  name: string;
  /** px; defaults to the size the stylesheet gives `.ico` */
  size?: number;
}

/** A 24x24 icon of the deck: strokes from ICONS, or a filled Fluent shape (`fl-*`, drawn with fill: class `.fluent`). */
export function Icon({ name, size }: IconProps) {
  const fluent = name in FLUENT;
  // the markup is a constant of this app (iconData.ts), never user input
  const html = `<svg viewBox="0 0 24 24">${FLUENT[name] ?? ICONS[name] ?? ''}</svg>`;
  const style = size ? ({ '--size': `${size}px` } as CSSProperties) : undefined;
  return <span className={fluent ? 'ico fluent' : 'ico'} aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}
