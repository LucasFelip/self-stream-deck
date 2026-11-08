import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { registerBack } from '../lib/back';
import { EMPTY_METRICS, PagerContext, type PageInfo, type PagerApi, type PagerMetrics } from './PagerContext';
import type { SectionId } from './sections';

interface PagerProps {
  /** the pages, in the order of the rail: each is a <Page> (its own `.page` element, so the stylesheet's selectors keep working) */
  pages: ReactNode;
  /** the navigation (rendered before the main area: a rail on the left in landscape, a bar at the bottom in portrait) */
  nav: (pager: PagerApi) => ReactNode;
  /** everything that goes inside `.main` before the pager (the offline notice) */
  aboveMain?: ReactNode;
  /** everything that goes outside `.main` (the menu) */
  children?: ReactNode;
}

const RESIZE_DEBOUNCE_MS = 120;

// Landscape: the rail is on the left, so the pages are stacked and swipe up / down in the rail's order. Portrait: side by side.
const isLandscape = (): boolean => window.matchMedia('(orientation: landscape)').matches;

const samePages = (a: readonly PageInfo[], b: readonly PageInfo[]): boolean => a.length === b.length && a.every((page, i) => page.id === b[i]?.id && page.section === b[i]?.section);
const sameMetrics = (a: PagerMetrics, b: PagerMetrics): boolean => (Object.keys(a) as Array<keyof PagerMetrics>).every((key) => a[key] === b[key]);

/**
 * The pager: all pages in one scroll-snap row (sideways in portrait, up / down in landscape). It finds its pages in the DOM (a section
 * can have several, like Atalhos), tracks the one on screen, keeps it through a rotation, jumps to a section from the tabs, shows the
 * page dots of a section with several pages, and tells the pages how big the room is so they can fit themselves to it.
 */
export function Pager({ pages: pageNodes, nav, aboveMain, children }: PagerProps) {
  const element = useRef<HTMLElement | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const [activeId, setActiveId] = useState('apps-0');
  const activeIdRef = useRef(activeId);
  // a jump asked for that has not arrived yet: a rotation or a rebuild in the middle of the slide must aim at it, not at the page we were on
  const pending = useRef<string | null>(null);
  const lastPageIn = useRef<Partial<Record<SectionId, string>>>({});
  const [metrics, setMetrics] = useState<PagerMetrics>(EMPTY_METRICS);
  const arranging = useRef(false);
  const [arrangingUi, setArrangingUi] = useState(false);
  const resizeDirty = useRef(false);

  const indexOfId = (id: string): number => pagesRef.current.findIndex((page) => page.id === id);

  const currentIndex = useCallback((): number => {
    const pager = element.current;
    if (!pager) return 0;
    const raw = isLandscape()
      ? pager.scrollTop / Math.max(1, pager.getBoundingClientRect().height)
      : pager.scrollLeft / Math.max(1, pager.clientWidth);
    return Math.min(Math.max(0, pagesRef.current.length - 1), Math.max(0, Math.round(raw)));
  }, []);

  const scrollToIndex = useCallback((index: number, smooth: boolean) => {
    const pager = element.current;
    if (!pager) return;
    const behavior: ScrollBehavior = smooth ? 'smooth' : 'instant';
    if (isLandscape()) pager.scrollTo({ left: 0, top: index * pager.getBoundingClientRect().height, behavior });
    else pager.scrollTo({ left: index * pager.clientWidth, top: 0, behavior });
  }, []);

  const readMetrics = useCallback((): PagerMetrics => {
    const pager = element.current;
    if (!pager) return EMPTY_METRICS;
    const style = getComputedStyle(pager);
    const safe = (name: string) => parseFloat(style.getPropertyValue(name)) || 0;
    return { width: pager.clientWidth, height: pager.clientHeight, safeLeft: safe('--safe-left'), safeRight: safe('--safe-right'), safeBottom: safe('--safe-bottom'), landscape: isLandscape() };
  }, []);

  const sync = useCallback(() => {
    const page = pagesRef.current[currentIndex()];
    if (!page) return;
    // sliding to a tab passes through the pages in between: only the page the slide ends on counts as "where you were"
    if (!pending.current || pending.current === page.id) lastPageIn.current[page.section] = page.id;
    if (pending.current === page.id) pending.current = null;
    activeIdRef.current = page.id;
    setActiveId(page.id);
  }, [currentIndex]);

  // the pages are whatever `.page` elements sit in the pager
  useLayoutEffect(() => {
    const pager = element.current;
    if (!pager) return undefined;
    const read = () => {
      const next = [...pager.querySelectorAll<HTMLElement>(':scope > .page')].map((page) => ({ id: page.dataset.id ?? '', section: (page.dataset.section ?? 'apps') as SectionId }));
      setPages((previous) => (samePages(previous, next) ? previous : next));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(pager, { childList: true });
    return () => observer.disconnect();
  }, []);

  // pages came or went: stay on the page we are on (its index may have moved); if it is gone, the first page of its section, else the first
  useLayoutEffect(() => {
    if (!pages.length) return;
    const wanted = pending.current ?? activeIdRef.current;
    let target = pages.findIndex((page) => page.id === wanted);
    if (target === -1) {
      const section = wanted.replace(/-\d+$/, '');
      target = Math.max(0, pages.findIndex((page) => page.section === section));
    }
    const page = pages[target];
    if (!page) return;
    scrollToIndex(target, false);
    if (page.id !== activeIdRef.current) {
      activeIdRef.current = page.id;
      setActiveId(page.id);
    }
  }, [pages, scrollToIndex]);

  useLayoutEffect(() => { setMetrics(readMetrics()); }, [readMetrics]);

  useEffect(() => {
    const pager = element.current;
    if (!pager) return undefined;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); };
    pager.addEventListener('scroll', onScroll, { passive: true });
    // the person takes over: whatever slide was pending is forgotten
    const onTouch = () => { pending.current = null; };
    pager.addEventListener('touchstart', onTouch, { passive: true });

    const keep = () => {
      // a rotation or a resize keeps the page the person is on (the browser would keep the old scroll offset)
      const index = indexOfId(pending.current ?? activeIdRef.current);
      if (index >= 0) scrollToIndex(index, false);
      sync();
    };
    const measure = () => {
      if (arranging.current) { resizeDirty.current = true; return; } // a key is lifted: never rebuild under the finger
      const next = readMetrics();
      setMetrics((previous) => (sameMetrics(previous, next) ? previous : next));
    };
    const observer = new ResizeObserver(() => {
      keep();
      clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(pager);
    const orientation = window.matchMedia('(orientation: landscape)');
    const onOrientation = () => { keep(); measure(); };
    orientation.addEventListener('change', onOrientation);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      pager.removeEventListener('scroll', onScroll);
      pager.removeEventListener('touchstart', onTouch);
      observer.disconnect();
      orientation.removeEventListener('change', onOrientation);
    };
  }, [sync, scrollToIndex, readMetrics]);

  const goToPage = useCallback((id: string): boolean => {
    const index = indexOfId(id);
    if (index === -1) return false;
    pending.current = id;
    scrollToIndex(index, true);
    return true;
  }, [scrollToIndex]);

  const goTo = useCallback((section: SectionId) => {
    const all = pagesRef.current;
    const current = all[currentIndex()];
    const inSection = all.filter((page) => page.section === section);
    // already in this section: back to its first page (nothing to do if we are there); coming from elsewhere: where we left it
    const target = current && current.section === section ? inSection[0] : inSection.find((page) => page.id === lastPageIn.current[section]) ?? inSection[0];
    if (target && target !== current) goToPage(target.id);
  }, [currentIndex, goToPage]);

  const setArranging = useCallback((on: boolean) => {
    arranging.current = on;
    setArrangingUi(on);
    if (!on && resizeDirty.current) {
      resizeDirty.current = false;
      const next = readMetrics();
      setMetrics((previous) => (sameMetrics(previous, next) ? previous : next));
    }
  }, [readMetrics]);

  const activePage = pages.find((page) => page.id === activeId);
  const active: SectionId = activePage?.section ?? 'apps';

  // Back with nothing open takes any page but Apps to Apps; on Apps it does nothing (a stray Back must not drop the deck).
  // Registered first so everything that can be undone (sheets, the menu) is asked before it.
  const activeSection = useRef(active);
  activeSection.current = active;
  useEffect(() => registerBack(() => {
    if (activeSection.current === 'apps') return false;
    const first = pagesRef.current.find((page) => page.section === 'apps');
    return first ? goToPage(first.id) : false;
  }), [goToPage]);

  const api = useMemo<PagerApi>(() => ({ active, activeId, pages, metrics, goTo, goToPage, setArranging }), [active, activeId, pages, metrics, goTo, goToPage, setArranging]);
  const sectionPages = pages.filter((page) => page.section === active);

  return (
    <PagerContext.Provider value={api}>
      {nav(api)}
      <div className="main">
        {aboveMain}
        <main id="pager" className={`pager${arrangingUi ? ' arranging' : ''}`} ref={element}>{pageNodes}</main>
        {/* where you are inside a section with several pages; never takes part in the layout */}
        <div id="page-dots" className="page-dots" aria-hidden="true" hidden={sectionPages.length < 2}>
          {sectionPages.length < 2 ? null : sectionPages.map((page) => <i key={page.id} className={page.id === activeId ? 'on' : undefined} />)}
        </div>
      </div>
      {children}
    </PagerContext.Provider>
  );
}
