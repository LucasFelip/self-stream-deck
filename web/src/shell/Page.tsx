import type { ReactNode } from 'react';
import { SECTIONS, type SectionId } from './sections';

interface PageProps {
  section: SectionId;
  /** the page's own class (`power-page`, ...), next to `page` */
  className?: string;
  /** extra `data-*` attributes (the Janelas page tells its pane this way) */
  data?: Record<string, string>;
  children?: ReactNode;
}

/** One page of the pager. Same element and attributes as the old interface's pages (`.page[data-section][data-id][data-title]`). */
export function Page({ section, className = '', data = {}, children }: PageProps) {
  const title = SECTIONS.find((candidate) => candidate.id === section)?.label ?? section;
  return (
    <section className={`${className} page`.trim()} data-section={section} data-id={section} data-title={title} {...Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]))}>
      {children}
    </section>
  );
}
