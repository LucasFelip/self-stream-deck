'use strict';

// What a config.json may contain. validate() returns the problems as { key, message }: the key is the top-level setting the
// problem is in, so a save can refuse only the setting it is changing and leave older problems to a warning at start-up.

const REPLACEMENT_CHAR = '�'; // what a wrong text encoding leaves behind ("�rea de trabalho")
const BOOLEANS = ['lan', 'powerControls', 'miniPlayer', 'editor'];
const PORTS = ['port', 'httpsPort'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';

function corruptedText(value, where, found) {
  if (isText(value)) {
    if (value.includes(REPLACEMENT_CHAR)) found.push(where);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => corruptedText(item, `${where}[${index}]`, found));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) corruptedText(item, `${where}.${key}`, found);
  }
}

function duplicates(items) {
  const seen = new Set();
  const twice = new Set();
  for (const item of items) (seen.has(item) ? twice : seen).add(item);
  return [...twice];
}

function validate(config) {
  const problems = [];
  const add = (key, message) => problems.push({ key, message });

  for (const key of PORTS) {
    if (config[key] !== undefined && !(Number.isInteger(config[key]) && config[key] >= 1 && config[key] <= 65535)) add(key, `${key} must be a whole number from 1 to 65535`);
  }
  for (const key of BOOLEANS) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') add(key, `${key} must be true or false`);
  }

  if (config.hidden !== undefined && !(Array.isArray(config.hidden) && config.hidden.every(isText))) add('hidden', 'hidden must be a list of app ids');

  if (config.tileOrder !== undefined) {
    const ok = isObject(config.tileOrder) && Object.values(config.tileOrder).every((list) => Array.isArray(list) && list.every(isText));
    if (!ok) add('tileOrder', 'tileOrder must map each page to a list of keys');
  }

  if (config.shortcuts !== undefined) {
    if (!Array.isArray(config.shortcuts) || !config.shortcuts.every((item) => isObject(item) && isText(item.keys) && (item.label === undefined || isText(item.label)) && (item.id === undefined || isText(item.id)))) {
      add('shortcuts', 'shortcuts must be a list of { id, label, keys }');
    } else {
      const twice = duplicates(config.shortcuts.map((item) => item.id).filter((id) => id !== undefined));
      if (twice.length) add('shortcuts', `shortcut ids must be unique (repeated: ${twice.join(', ')})`);
    }
  }

  if (config.macros !== undefined) {
    if (!Array.isArray(config.macros) || !config.macros.every((item) => isObject(item) && isText(item.id) && Array.isArray(item.steps))) {
      add('macros', 'macros must be a list of { id, label, steps }');
    } else {
      const twice = duplicates(config.macros.map((item) => item.id));
      if (twice.length) add('macros', `macro ids must be unique (repeated: ${twice.join(', ')})`);
    }
  }

  for (const key of Object.keys(config)) {
    const found = [];
    corruptedText(config[key], key, found);
    for (const where of found) add(key, `${where} has damaged characters (text saved with the wrong encoding?)`);
  }
  return problems;
}

module.exports = { validate };
