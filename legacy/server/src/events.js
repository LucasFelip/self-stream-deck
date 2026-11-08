'use strict';

/**
 * Server-sent events: the PC tells the phone when something changed, instead of the phone asking every second or two.
 * A topic (windows, state, audio, media, monitor, processes, power) has a producer that is started when the first client
 * subscribes and stopped when the last one leaves, so nothing is watched while nobody looks. A new value is sent only when
 * it differs from the last one (by its signature), and a client that joins a running topic gets the last value at once.
 *
 *   GET /api/events?topics=windows,state   ->   event: windows\ndata: {...}\n\n   ...
 */

const { log } = require('./log');

const KEEPALIVE_MS = 20_000;

const topics = new Map(); // name -> { producer, clients, lastJson, lastSignature, running }
let keepAlive = null;

/** producer: { start(publish), stop() }; publish(data, { signature?, force? }) */
function register(name, producer) {
  topics.set(name, { producer, clients: new Set(), lastJson: null, lastSignature: null, running: false });
}

const names = () => [...topics.keys()];

function write(res, name, json) {
  if (res.writableNeedDrain) return; // a client that cannot keep up misses this one; the next value catches it up
  res.write(`event: ${name}\ndata: ${json}\n\n`);
}

function publish(name, data, { signature, force = false } = {}) {
  const topic = topics.get(name);
  if (!topic || !topic.running) return;
  const json = JSON.stringify(data);
  const sig = signature === undefined ? json : signature;
  if (!force && sig === topic.lastSignature) return; // nothing new
  topic.lastJson = json;
  topic.lastSignature = sig;
  for (const res of topic.clients) write(res, name, json);
}

function startTopic(name, topic) {
  topic.running = true;
  topic.lastJson = null;
  topic.lastSignature = null;
  try {
    topic.producer.start((data, options) => publish(name, data, options));
  } catch (err) {
    console.warn(`[events] ${name}: ${err.message}`);
  }
}

function stopTopic(topic) {
  if (!topic.running) return;
  topic.running = false;
  try {
    topic.producer.stop();
  } catch (err) {
    log.warn(`[events] a producer failed to stop: ${err.message}`); // it is marked stopped either way; it starts fresh next time
  }
}

function leave(res, wanted) {
  for (const name of wanted) {
    const topic = topics.get(name);
    if (!topic) continue;
    topic.clients.delete(res);
    if (!topic.clients.size) stopTopic(topic);
  }
  if (keepAlive && ![...topics.values()].some((topic) => topic.clients.size)) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}

/** Answers a GET /api/events request and keeps the response open. */
function subscribe(req, res, requested) {
  const wanted = [...new Set(requested)].filter((name) => topics.has(name));
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write('retry: 2000\n\n');
  req.socket.setNoDelay(true);

  for (const name of wanted) {
    const topic = topics.get(name);
    topic.clients.add(res);
    if (!topic.running) startTopic(name, topic);
    else if (topic.lastJson !== null) write(res, name, topic.lastJson);
  }

  if (!keepAlive) {
    keepAlive = setInterval(() => {
      for (const topic of topics.values()) for (const res of topic.clients) if (!res.writableNeedDrain) res.write(': keep-alive\n\n');
    }, KEEPALIVE_MS);
    keepAlive.unref();
  }

  req.on('close', () => leave(res, wanted));
}

function stopAll() {
  for (const topic of topics.values()) {
    for (const res of topic.clients) res.end();
    topic.clients.clear();
    stopTopic(topic);
  }
}

module.exports = { register, subscribe, publish, names, stopAll };
