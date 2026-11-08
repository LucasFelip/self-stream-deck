'use strict';

const { Host } = require('./host');

const IDLE_STOP_MS = 3 * 60 * 1000;
const host = new Host('notifications', 'notifications-host.ps1', { timeoutMs: 12000, idleStopMs: IDLE_STOP_MS, retryOps: ['list'] });

const clean = (text) => String(text || '').toLowerCase();

/**
 * The notifications from the Action Center that the deck should show, newest last. `apps` are words matched against the
 * app's name and its id ("whatsapp" matches "5319275A.WhatsAppDesktop_..."); no words: nothing is shown.
 */
async function list(apps) {
  const words = (Array.isArray(apps) ? apps : []).map(clean).filter(Boolean);
  const { access, notifications } = await host.request({ op: 'list' });
  if (access !== 'allowed') return { access, notifications: [] };
  const wanted = notifications.filter((item) => words.some((word) => clean(item.app).includes(word) || clean(item.aumid).includes(word)));
  return { access, notifications: wanted.map(({ id, app, title, body, time }) => ({ id, app: app || '', title, body, time })) };
}

module.exports = { stop: () => host.stop(), list };
