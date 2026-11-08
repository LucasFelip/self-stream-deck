import { createContext, useContext } from 'react';
import type { SectionId } from './sections';

/** A page of the pager, as found in the DOM: sections can have several (Atalhos paginates). */
export interface PageInfo {
  id: string;
  section: SectionId;
}

/** What the pages need to fit themselves to the real screen: the pager's size and the insets it keeps clear of (camera cut-out, system bars). */
export interface PagerMetrics {
  width: number;
  height: number;
  safeLeft: number;
  safeRight: number;
  safeBottom: number;
  /** landscape: the tabs are a rail on the left and the pages are stacked */
  landscape: boolean;
}

export interface PagerApi {
  /** the section whose page is on screen */
  active: SectionId;
  /** the id of the page on screen (`apps-0`, `shortcuts-1`, `power`...) */
  activeId: string;
  pages: readonly PageInfo[];
  metrics: PagerMetrics;
  /** a tab: the first page of the section if you are in it already, otherwise the page you last had open there */
  goTo: (section: SectionId) => void;
  /** a page by id; false if there is no such page (yet) */
  goToPage: (id: string) => boolean;
  /** a key is lifted: the pages must not be rebuilt under the finger (a resize waits for the drop) */
  setArranging: (on: boolean) => void;
}

export const EMPTY_METRICS: PagerMetrics = { width: 0, height: 0, safeLeft: 0, safeRight: 0, safeBottom: 0, landscape: false };

export const PagerContext = createContext<PagerApi>({
  active: 'apps',
  activeId: 'apps-0',
  pages: [],
  metrics: EMPTY_METRICS,
  goTo: () => undefined,
  goToPage: () => false,
  setArranging: () => undefined,
});

export const usePager = (): PagerApi => useContext(PagerContext);

/** true while this section's page is the visible one: where a page starts and stops its live updates and timers */
export const useIsActive = (section: SectionId): boolean => useContext(PagerContext).active === section;
