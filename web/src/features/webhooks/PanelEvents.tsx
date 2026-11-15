import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { hub } from '../../api/events';
import { vibrate } from '../../lib/haptics';
import { usePager } from '../../shell/PagerContext';
import { SECTIONS, type SectionId } from '../../shell/sections';
import { useToast } from '../../ui/Toast';
import { newEvents, noticeText, pageOf, ruleOf, type PanelCursor, type PanelFrame } from './panelQueue';

const SHOW_MS = 6000;
const isSection = (page: string): page is SectionId => SECTIONS.some((section) => section.id === page);

/**
 * What scripts, CI and home automation ask of the panel through the webhooks: show a notice (with a short buzz), switch the page, reload what is
 * shown. It listens to the `panel` topic from every page. Nothing here reaches the PC: the webhooks only ever touch the panel.
 */
export function PanelEvents() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const pager = usePager();
  const cursor = useRef<PanelCursor>(null);
  // where the person was when a rule switched the page, so `back` (the rule ended) can return there
  const before = useRef(new Map<string, string>());
  // the pager changes with every swipe: the subscription reads the latest one instead of resubscribing
  const pagerRef = useRef(pager);
  pagerRef.current = pager;

  useEffect(() => hub.subscribe('panel', (data) => {
    const result = newEvents(cursor.current, data as PanelFrame);
    cursor.current = result.cursor;
    const notices = result.events.filter((event) => event.kind === 'notify');
    const last = notices[notices.length - 1];
    if (last) {
      toast(noticeText(last.data) + (notices.length > 1 ? ` (+${notices.length - 1})` : ''), false, SHOW_MS);
      vibrate();
    }
    for (const event of result.events) {
      if (event.kind === 'goto') {
        const page = pageOf(event.data);
        const rule = ruleOf(event.data);
        if (rule && !before.current.has(rule)) before.current.set(rule, pagerRef.current.activeId);
        if (page) { if (isSection(page)) pagerRef.current.goTo(page); else pagerRef.current.goToPage(page); }
      } else if (event.kind === 'back') {
        const rule = ruleOf(event.data);
        const page = rule ? before.current.get(rule) : undefined;
        if (rule) before.current.delete(rule);
        if (page) pagerRef.current.goToPage(page);
      } else if (event.kind === 'refresh') {
        void queryClient.invalidateQueries();
      }
    }
  }), [toast, queryClient]);

  return null;
}
