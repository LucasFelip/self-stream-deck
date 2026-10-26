'use strict';

/**
 * Windows notifications on the deck. The PC keeps the ones from the chosen apps (config.notifications.apps, WhatsApp by default)
 * even when Do Not Disturb or a game hides them; each new one shows up here as a notice with a short buzz. What was already
 * waiting when the deck connected is not announced again.
 */
(() => {
  const { toast: showToast, vibrate } = Deck;
  const SHOW_MS = 6000;
  const MAX_TEXT = 140;

  const seen = new Set();
  let first = true;

  const line = ({ app, title, body }) => {
    const text = [title, body].filter(Boolean).join(': ').replace(/\s+/g, ' ');
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
    return `🔔 ${app ? `${app} · ` : ''}${clipped}`;
  };

  Deck.live.subscribe('notifications', ({ notifications }) => {
    const fresh = notifications.filter((item) => !seen.has(`${item.id}|${item.time}`));
    for (const item of notifications) seen.add(`${item.id}|${item.time}`);
    if (first) { first = false; return; }
    if (!fresh.length) return;
    showToast(line(fresh[fresh.length - 1]) + (fresh.length > 1 ? ` (+${fresh.length - 1})` : ''), false, SHOW_MS);
    vibrate();
  });
})();
