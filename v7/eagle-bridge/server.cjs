'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
function createBridgeServer({ service, token = crypto.randomBytes(24).toString('hex'), port = 41596 }) {
  const key = Buffer.from(token);
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const presented = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (req.headers.origin || presented.length !== key.length || !crypto.timingSafeEqual(key, presented)) return send(403, { ok: false, code: 'EAGLE_PAIRING_REQUIRED', message: 'Pair this session from the Eagle bridge window' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { ok: true, ...service.status() });
      if (req.method === 'GET' && url.pathname === '/v1/catalog') return send(200, { ok: true, ...await service.catalog(url.searchParams.get('query') || '') });
      if (req.method === 'GET' && url.pathname === '/v1/receipts') return send(200, { ok: true, receipts: await service.receipts() });
      if (req.method !== 'POST' || !['/v1/prepare', '/v1/commit'].includes(url.pathname)) return send(404, { ok: false, code: 'EAGLE_OPERATION_DENIED' });
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return send(415, { ok: false, code: 'EAGLE_JSON_REQUIRED' });
      let body = '', bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) return send(413, { ok: false, code: 'EAGLE_INPUT_TOO_LARGE' }); body += chunk; }
      const input = JSON.parse(body);
      if (url.pathname === '/v1/prepare') return send(200, { ok: true, plan: await service.prepare(input) });
      if (!input || typeof input !== 'object' || Object.keys(input).some(k => k !== 'planId')) return send(400, { ok: false, code: 'EAGLE_INPUT_INVALID' });
      send(200, await service.commit(input.planId));
    } catch (error) { send(400, { ok: false, code: error.code || 'EAGLE_BRIDGE_FAILED', message: error.message }); }
  });
  server.requestTimeout = 30000;
  return { token, server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); }); }), close: () => new Promise(resolve => server.close(resolve)) };
}
module.exports = { createBridgeServer };
