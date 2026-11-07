'use strict';

const http = require('node:http');
const os = require('node:os');
const { sendBuffer, sendJson } = require('./http');
const { homeAddresses } = require('./addresses');

/**
 * The plain-HTTP side of the iPhone setup. Safari cannot open the deck over HTTPS until it trusts the authority that signed the
 * certificate, so the authority's PUBLIC certificate is handed out here, over HTTP, with nothing else on this port:
 *   GET /        a short page with the certificate's SHA-256 fingerprint (compare it with `npm run lan -- ios`) and the download link
 *   GET /ca.cer  the certificate itself (no secret in it; the private key never leaves data/tls/ios/)
 * No token is needed because nothing here is private, and nothing here can drive the deck.
 */

const page = (fingerprint) => `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Self Stream Deck · certificado</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#0b0c10;color:#e8e8ee;margin:0;padding:24px}a.b{display:block;margin:20px 0;padding:14px;border-radius:12px;background:#3b82f6;color:#fff;text-align:center;text-decoration:none;font-weight:600}code{display:block;word-break:break-all;background:#1a1c24;padding:10px;border-radius:8px;font-size:12px}</style>
</head><body>
<h1>Self Stream Deck</h1>
<p>Certificado para o iPhone confiar no painel.</p>
<a class="b" href="/ca.cer">Baixar certificado</a>
<p>Impressão digital (SHA-256). Confira com a que o PC mostra em <b>npm run lan -- ios</b>:</p>
<code>${fingerprint}</code>
<p>Depois: Ajustes → Perfil Baixado → Instalar; e Ajustes → Geral → Sobre → Ajustes de Confiança do Certificado → ativar.</p>
</body></html>`;

/** `getMaterial()` gives the current { caDer, caFingerprint } (the authority never changes, but it is read at request time). */
function createCaServer(getMaterial) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const { pathname } = new URL(req.url, 'http://localhost');
    const material = getMaterial();
    if (!material) return sendJson(res, 503, { error: 'certificate not ready' });
    if (pathname === '/ca.cer') {
      return sendBuffer(res, material.caDer, 'application/x-x509-ca-cert', { 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="self-stream-deck-ca.cer"' });
    }
    if (pathname === '/') return sendBuffer(res, Buffer.from(page(material.caFingerprint)), 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' });
    return sendJson(res, 404, { error: 'not found' });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.on('clientError', () => {});
  return server;
}

/** The addresses to type on the iPhone: where to install the certificate authority, and the pairing links (IP first, then the .local name). */
function links(config) {
  const hosts = [...homeAddresses(), `${os.hostname().toLowerCase()}.local`];
  return {
    install: hosts.map((host) => `http://${host}:${config.iosCaPort}/`),
    pair: hosts.map((host) => `https://${host}:${config.iosPort}/?token=${config.token}`),
  };
}

module.exports = { createCaServer, page, links };
