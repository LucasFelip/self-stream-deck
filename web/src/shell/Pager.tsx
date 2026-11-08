import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { registerBack } from '../lib/back';
import { PagerContext, type PagerApi } from './PagerContext';
import { SECTIONS, type SectionId } from './sections';

interface PagerProps {
  /** one <Page> per section (each renders its own `.page` element so the stylesheet's selectors keep working) */
  pages: Record<SectionId, ReactNode>;
  /** the navigation (rendered before the main area: a rail on the left in landscape, a bar at the bottom in portrait) */
  nav: (pager: PagerApi) => ReactNode;
  /** everything that goes inside `.main` besides the pager (the offline notice) */
  aboveMain?: ReactNode;
  children?: ReactNode;
}

// Landscape: the rail is on the left, so the pages are stacked and swipe up / down in the rail's order. Portrait: side by side.
const isVertical = (): boolean => window.matchMedia('(orientation: landscape)').matches;

/**
 * The pager: all pages in one scroll-snap row (sideways in portrait, up / down in landscape), the section the person is on,
 * and the jump to a section from the tabs. The page that is on screen is told by `useIsActive` so it can stop its work when hidden.
 */
export function Pager({ pages, nav, aboveMain, children }: PagerProps) {
  const element = useRef<HTMLElement | null>(null);
  const [active, setActive] = useState<SectionId>('apps');
  const activeRef = useRef<SectionId>('apps');
  // a jump asked for that has not arrived yet: a rotation in the middle of the slide must aim at it, not at the page we were on
  const pending = useRef<SectionId | null>(null);

  const indexOf = (section: SectionId): number => SECTIONS.findIndex((candidate) => candidate.id === section);

  const currentIndex = useCallback((): number => {
    const pager = element.current;
    if (!pager) return 0;
    const raw = isVertical()
      ? pager.scrollTop / Math.max(1, pager.getBoundingClientRect().height)
      : pager.scrollLeft / Math.max(1, pager.clientWidth);
    return Math.min(SECTIONS.length - 1, Math.max(0, Math.round(raw)));
  }, []);

  const scrollToIndex = useCallback((index: number, smooth: boolean) => {
    const pager = element.current;
    if (!pager) return;
    const behavior: ScrollBehavior = smooth ? 'smooth' : 'instant';
    if (isVertical()) pager.scrollTo({ left: 0, top: index * pager.getBoundingClientRect().height, behavior });
    else pager.scrollTo({ left: index * pager.clientWidth, top: 0, behavior });
  }, []);

  const goTo = useCallback((section: SectionId) => {
    pending.current = section;
    scrollToIndex(indexOf(section), true);
  }, [scrollToIndex]);

  const sync = useCallback(() => {
    const section = SECTIONS[currentIndex()]?.id;
    if (!section) return;
    if (pending.current === section) pending.current = null;
    activeRef.current = section;
    setActive(section);
  }, [currentIndex]);

  useEffect(() => {
    const pager = element.current;
    if (!pager) return undefined;
    let frame = 0;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); };
    pager.addEventListener('scroll', onScroll, { passive: true });

    // a rotation or a resize keeps the page the person is on (the browser would keep the old scroll offset)
    const keep = () => { scrollToIndex(indexOf(pending.current ?? activeRef.current), false); sync(); };
    const observer = new ResizeObserver(keep);
    observer.observe(pager);
    const orientation = window.matchMedia('(orientation: landscape)');
    orientation.addEventListener('change', keep);
    return () => {
      cancelAnimationFrame(frame);
      pager.removeEventListener('scroll', onScroll);
      observer.disconnect();
      orientation.removeEventListener('change', keep);
    };
  }, [sync, scrollToIndex]);

  // Back with nothing open takes any page but Apps to Apps; on Apps it does nothing (a stray Back must not drop the deck).
  // Registered first so everything that can be undone (sheets, the menu) is asked before it.
  useEffect(() => registerBack(() => {
    if (activeRef.current === 'apps') return false;
    goTo('apps');
    return true;
  }), [goTo]);

  const api = useMemo<PagerApi>(() => ({ active, goTo }), [active, goTo]);

  return (
    <PagerContext.Provider value={api}>
      {nav(api)}
      <div className="main">
        {aboveMain}
        <main id="pager" className="pager" ref={element}>
          {SECTIONS.map((section) => <Fragment key={section.id}>{pages[section.id]}</Fragment>)}
        </main>
      </div>
      {children}
    </PagerContext.Provider>
  );
}
