// rain-relay — Cloudflare Worker
//
// Routes:
//   GET  /control            -> current animation params (public read)
//   POST /control             -> set new params (requires X-Auth: CONTROL_SECRET)
//   POST /touch                -> browser reports a real touch/drag; broadcast live
//                                 over the /watch WebSocket, and logged as a fallback
//   GET  /touches              -> recent touch log (fallback if nobody was listening live)
//   POST /snapshot              -> browser reports a periodic water-state snapshot
//   GET  /snapshot?since=<ms>   -> read back snapshots newer than `since`
//   GET  /watch                 -> WebSocket upgrade; every /touch POST is broadcast here
//
// KV layout (binding RAIN_KV):
//   "control"            -> JSON blob of current LIVE params
//   "touches"             -> JSON array of {t, dist} objects, capped
//   "snapshots"            -> JSON array of snapshot objects, capped

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Auth',
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const TOUCH_CAP = 50;
const SNAPSHOT_CAP = 500;

async function appendCapped(kv, key, item, cap) {
  var raw = await kv.get(key);
  var list = raw ? JSON.parse(raw) : [];
  list.push(item);
  if (list.length > cap) list = list.slice(list.length - cap);
  await kv.put(key, JSON.stringify(list));
  return list;
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // ---- live touch channel ----
    if (path === '/watch') {
      var id = env.TOUCH_HUB.idFromName('singleton');
      var stub = env.TOUCH_HUB.get(id);
      return stub.fetch(request);
    }

    if (path === '/touch' && request.method === 'POST') {
      var body = {};
      try { body = await request.json(); } catch (e) {}
      var event = { t: Date.now(), dist: +body.dist || 0 };

      var hubId = env.TOUCH_HUB.idFromName('singleton');
      var hub = env.TOUCH_HUB.get(hubId);

      // background work must be wrapped in waitUntil, or the Worker can be
      // torn down right after the response is returned, before it finishes
      ctx.waitUntil(appendCapped(env.RAIN_KV, 'touches', event, TOUCH_CAP));
      ctx.waitUntil(hub.fetch('https://internal/broadcast', {
        method: 'POST',
        body: JSON.stringify(event),
      }).catch(function () {}));

      return json({ ok: true });
    }

    if (path === '/touches' && request.method === 'GET') {
      var raw = await env.RAIN_KV.get('touches');
      return json(raw ? JSON.parse(raw) : []);
    }

    // ---- control (animation params) ----
    if (path === '/control' && request.method === 'GET') {
      var raw2 = await env.RAIN_KV.get('control');
      return json(raw2 ? JSON.parse(raw2) : {});
    }

    if (path === '/control' && request.method === 'POST') {
      if (request.headers.get('X-Auth') !== env.CONTROL_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      var body2 = {};
      try { body2 = await request.json(); } catch (e) {}
      await env.RAIN_KV.put('control', JSON.stringify(body2));
      return json({ ok: true });
    }

    // ---- snapshots (pulled on demand, never pushed) ----
    if (path === '/snapshot' && request.method === 'POST') {
      var snap = {};
      try { snap = await request.json(); } catch (e) {}
      snap.t = Date.now();
      await appendCapped(env.RAIN_KV, 'snapshots', snap, SNAPSHOT_CAP);
      return json({ ok: true });
    }

    if (path === '/snapshot' && request.method === 'GET') {
      var since = +url.searchParams.get('since') || 0;
      var raw3 = await env.RAIN_KV.get('snapshots');
      var list = raw3 ? JSON.parse(raw3) : [];
      if (since > 0) list = list.filter(function (s) { return s.t > since; });
      return json(list);
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};

// Durable Object: holds live WebSocket connections and rebroadcasts /touch events.
export class TouchHub {
  constructor(state) {
    this.sockets = new Set();
  }

  async fetch(request) {
    var url = new URL(request.url);

    if (url.pathname === '/broadcast') {
      var payload = await request.text();
      for (var ws of this.sockets) {
        try { ws.send(payload); } catch (e) { this.sockets.delete(ws); }
      }
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    var pair = new WebSocketPair();
    var client = pair[0], server = pair[1];
    server.accept();
    this.sockets.add(server);

    var self = this;
    server.addEventListener('close', function () { self.sockets.delete(server); });
    server.addEventListener('error', function () { self.sockets.delete(server); });

    return new Response(null, { status: 101, webSocket: client });
  }
}
