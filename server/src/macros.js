'use strict';

const crypto = require('node:crypto');
const keys = require('./keys');

/**
 * What the phone's button editor may create: keyboard shortcuts and macros (a list of steps).
 * Everything is validated against a fixed whitelist before it is stored. A macro step names an app by an id from the
 * taskbar list, a device by an id from the live list, or one of a few fixed actions; there is no way to put a command
 * line, a path or text to type in a macro.
 */

const LIMITS = { label: 40, shortcuts: 60, macros: 40, steps: 40, waitMs: 10000, totalWaitMs: 60000, deviceId: 300 };
const MEDIA = new Set(['prev', 'playpause', 'next']);
const ZONES = new Set(['left', 'right', 'full']);
const PAGES = new Set(['shortcuts', 'apps']);

const bad = (message) => Object.assign(new Error(message), { status: 400 });

function text(value, name, max = LIMITS.label) {
  if (typeof value !== 'string') throw bad(`${name} must be text`);
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw bad(`${name} is empty`);
  if (trimmed.length > max) throw bad(`${name} is too long`);
  return trimmed;
}

function toggle(value, name) {
  if (value === true || value === false || value === 'toggle') return value;
  throw bad(`${name} must be true, false or "toggle"`);
}

function integer(value, name, low, high) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < low || n > high) throw bad(`${name} must be a whole number from ${low} to ${high}`);
  return n;
}

function newId(prefix, label, taken) {
  const slug = label.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || prefix;
  let id;
  do { id = `${slug}-${crypto.randomBytes(2).toString('hex')}`; } while (taken.has(id));
  return id;
}

function keysSpec(value) {
  const spec = text(value, 'keys', 60).toLowerCase().replace(/\s+/g, '');
  keys.parse(spec); // throws on an unknown key or too many keys
  return spec;
}

/** A list of { id?, label, keys } from the editor -> the stored list (ids kept, new ones created, order as given). */
function normalizeShortcuts(items) {
  if (!Array.isArray(items) || items.length > LIMITS.shortcuts) throw bad('invalid shortcuts list');
  const taken = new Set();
  return items.map((item) => {
    const label = text(item && item.label, 'label');
    const spec = keysSpec(item && item.keys);
    let id = typeof (item && item.id) === 'string' && /^[a-z0-9-]{1,40}$/.test(item.id) && !taken.has(item.id) ? item.id : null;
    if (!id) id = newId('atalho', label, taken);
    taken.add(id);
    return { id, label, keys: spec };
  });
}

function normalizeStep(step, appIds) {
  if (!step || typeof step !== 'object') throw bad('invalid step');
  switch (step.type) {
    case 'launch':
      if (!appIds.has(step.app)) throw bad('unknown app in a step');
      return { type: 'launch', app: step.app };
    case 'keys':
      return { type: 'keys', keys: keysSpec(step.keys) };
    case 'media':
      if (!MEDIA.has(step.key)) throw bad('invalid media key');
      return { type: 'media', key: step.key };
    case 'volume':
      return { type: 'volume', level: integer(step.level, 'level', 0, 100) };
    case 'mute':
      return { type: 'mute', muted: toggle(step.muted, 'muted') };
    case 'mic':
      return { type: 'mic', muted: toggle(step.muted, 'muted') };
    case 'output': {
      const device = text(step.device, 'device', LIMITS.deviceId);
      const name = typeof step.name === 'string' ? step.name.trim().slice(0, 80) : '';
      return { type: 'output', device, name };
    }
    case 'place':
      if (!appIds.has(step.app)) throw bad('unknown app in a step');
      if (!ZONES.has(step.zone)) throw bad('invalid zone');
      return { type: 'place', app: step.app, monitor: integer(step.monitor, 'screen', 0, 15), zone: step.zone };
    case 'wait':
      return { type: 'wait', ms: integer(step.ms, 'wait', 100, LIMITS.waitMs) };
    case 'camera':
      if (typeof step.on !== 'boolean') throw bad('camera must be on or off');
      return { type: 'camera', on: step.on };
    default:
      throw bad('unknown step type');
  }
}

function normalizeMacros(items, appIds) {
  if (!Array.isArray(items) || items.length > LIMITS.macros) throw bad('invalid macros list');
  const taken = new Set();
  return items.map((item) => {
    const label = text(item && item.label, 'label');
    if (!Array.isArray(item.steps) || !item.steps.length || item.steps.length > LIMITS.steps) throw bad(`a macro needs 1 to ${LIMITS.steps} steps`);
    const steps = item.steps.map((step) => normalizeStep(step, appIds));
    const waited = steps.reduce((sum, step) => sum + (step.type === 'wait' ? step.ms : 0), 0);
    if (waited > LIMITS.totalWaitMs) throw bad('the waits add up to more than a minute');
    let id = typeof item.id === 'string' && /^[a-z0-9-]{1,40}$/.test(item.id) && !taken.has(item.id) ? item.id : null;
    if (!id) id = newId('macro', label, taken);
    taken.add(id);
    return { id, label, page: PAGES.has(item.page) ? item.page : 'shortcuts', steps };
  });
}

/**
 * Runs the steps in order. `handlers` does the real work, one function per step type (they throw on failure); a failing
 * step is reported and the macro goes on. Steps of type "camera" belong to the phone: they are handed back to be run there.
 */
async function run(macro, handlers, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const results = [];
  const client = [];
  for (const step of macro.steps) {
    try {
      if (step.type === 'camera') client.push(step);
      else if (step.type === 'wait') await sleep(step.ms);
      else if (handlers[step.type]) await handlers[step.type](step);
      else throw new Error(`no handler for ${step.type}`);
      results.push({ type: step.type, ok: true });
    } catch (err) {
      results.push({ type: step.type, ok: false, error: err.message });
    }
  }
  return { results, client, failed: results.filter((result) => !result.ok).length };
}

module.exports = { normalizeShortcuts, normalizeMacros, run, LIMITS };
