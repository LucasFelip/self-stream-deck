import type { CSSProperties, ReactNode } from 'react';
import { SECTIONS, type SectionId } from './sections';

interface PageProps {
  section: SectionId;
  /** the page's id; defaults to the section's (a section with several pages numbers them: `shortcuts-0`, `shortcuts-1`) */
  id?: string;
  /** the page's own class (`power-page`, ...), next to `page` */
  className?: string;
  /** the title; defaults to the section's label */
  title?: string;
  /** extra `data-*` attributes (the Janelas page tells its pane this way) */
  data?: Record<string, string>;
  style?: CSSProperties;
  children?: ReactNode;
}

/** One page of the pager. Same element and attributes as the old interface's pages (`.page[data-section][data-id][data-title]`). */
export function Page({ section, id, className = '', title, data = {}, style, children }: PageProps) {
  const label = title ?? SECTIONS.find((candidate) => candidate.id === section)?.label ?? section;
  return (
    <section
      className={`${className} page`.trim()}
      data-section={section}
      data-id={id ?? section}
      data-title={label}
      style={style}
      {...Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]))}
    >
      {children}
    </section>
  );
}
