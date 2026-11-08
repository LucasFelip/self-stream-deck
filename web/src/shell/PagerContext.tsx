import { createContext, useContext } from 'react';
import type { SectionId } from './sections';

export interface PagerApi {
  /** the section whose page is on screen */
  active: SectionId;
  goTo: (section: SectionId) => void;
}

export const PagerContext = createContext<PagerApi>({ active: 'apps', goTo: () => undefined });

export const usePager = (): PagerApi => useContext(PagerContext);

/** true while this section's page is the visible one: where a page starts and stops its live updates and timers */
export const useIsActive = (section: SectionId): boolean => useContext(PagerContext).active === section;
