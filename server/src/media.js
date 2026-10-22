'use strict';

const { Host } = require('./host');

const IDLE_STOP_MS = 3 * 60 * 1000;
const host = new Host('media', 'media-host.ps1', { timeoutMs: 12000, idleStopMs: IDLE_STOP_MS, native: 'media', retryOps: ['state', 'art'] });

// "Spotify.exe" -> "Spotify", "brave" -> "Brave", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" -> "ZuneMusic"
const KNOWN = { spotify: 'Spotify', brave: 'Brave', chrome: 'Chrome', msedge: 'Edge', firefox: 'Firefox', vlc: 'VLC', opera: 'Opera', vivaldi: 'Vivaldi' };

function appName(id) {
  const base = String(id).split('!')[0].replace(/\.exe$/i, '').split(/[\\/]/).pop();
  const key = base.toLowerCase().replace(/[^a-z]/g, '');
  const known = Object.entries(KNOWN).find(([name]) => key.includes(name));
  if (known) return known[1];
  const readable = base.split('_')[0].split('.').pop();
  return readable.charAt(0).toUpperCase() + readable.slice(1);
}

const artCache = new Map(); // artKey -> { mime, data: Buffer } | null
const ART_LIMIT = 40;

function remember(key, value) {
  if (artCache.size >= ART_LIMIT) artCache.delete(artCache.keys().next().value);
  artCache.set(key, value);
}

async function state() {
  const { current, sessions } = await host.request({ op: 'state' });
  return {
    current,
    sessions: sessions.map((session) => ({ ...session, app: appName(session.id) })),
  };
}

const control = (session, action, position) => host.request({ op: 'control', session, action, position }).then(({ accepted }) => accepted);

// Windows often leaves the content type empty, so look at the file signature.
function sniffMime(buffer) {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length > 12 && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length > 3 && buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

// Cover art is fetched once per track (the key changes with title/artist/album) and kept in memory.
async function art(session, key) {
  if (artCache.has(key)) return artCache.get(key);
  const { data } = await host.request({ op: 'art', session });
  const bytes = data ? Buffer.from(data, 'base64') : null;
  const entry = bytes && bytes.length ? { mime: sniffMime(bytes), data: bytes } : null;
  remember(key, entry);
  return entry;
}

module.exports = { stop: () => host.stop(), state, control, art };
