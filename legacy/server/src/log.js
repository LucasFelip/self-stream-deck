'use strict';

// One place for what the server says. Messages carry their own "[tag]" prefix. SSD_LOG=debug|info|warn|error|silent picks how much
// is shown (default info). `debug` is where errors that are ignored on purpose go (see swallow), so a failure that left no
// trace before can be seen by starting the server with SSD_LOG=debug.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const threshold = () => LEVELS[String(process.env.SSD_LOG || 'info').toLowerCase()] ?? LEVELS.info;

const emit = (level, write) => (...args) => { if (LEVELS[level] >= threshold()) write(...args); };

const log = {
  debug: emit('debug', (...args) => console.log(...args)),
  info: emit('info', (...args) => console.log(...args)),
  warn: emit('warn', (...args) => console.warn(...args)),
  error: emit('error', (...args) => console.error(...args)),
};

/** For a catch that does nothing on purpose: `catch (err) { swallow('[taskbar] cache not written', err); }` */
const swallow = (what, err) => log.debug(`${what}: ${err && err.message ? err.message : err}`);

module.exports = { log, swallow };
