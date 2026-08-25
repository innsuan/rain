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
//   POST /capture               -> request a frame grab (requires X-Auth: CONTROL_SECRET)
//   GET  /capture               -> current capture request timestamp (page polls this)
//   POST /frame                 -> page uploads the canvas as a data URL after a capture request
//   GET  /frame                 -> read back the latest uploaded frame
//
// KV layout (binding RAIN_KV):
//   "control"            -> JSON blob of current LIVE params
//   "touches"             -> JSON array of {t, dist} objects, capped
//   "snapshots"            -> JSON array of snapshot objects, capped
//   "captureAt"            -> timestamp of the most recent capture request
//   "frame"                -> {t, dataUrl} of the most recently uploaded canvas frame

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Auth',
};

function clamp01(v) {
  var n = +v;
  return isFinite(n) ? Math.min(Math.max(n, 0), 1) : 0.5;
}

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

    // ---- state readings (pulled on demand, never pushed) ----
    // /snapshot is kept as an alias so an un-refreshed page keeps reporting.
    if ((path === '/state' || path === '/snapshot') && request.method === 'POST') {
      var snap = {};
      try { snap = await request.json(); } catch (e) {}
      snap.t = Date.now();
      await appendCapped(env.RAIN_KV, 'snapshots', snap, SNAPSHOT_CAP);
      return json({ ok: true });
    }

    if ((path === '/state' || path === '/snapshot') && request.method === 'GET') {
      var since = +url.searchParams.get('since') || 0;
      var raw3 = await env.RAIN_KV.get('snapshots');
      var list = raw3 ? JSON.parse(raw3) : [];
      if (since > 0) list = list.filter(function (s) { return s.t > since; });
      return json(list);
    }

    // ---- stir: a stroke drawn across the water from this side ----
    // Coordinates are normalized 0-1 so they mean the same thing on any screen.
    if (path === '/stir' && request.method === 'POST') {
      if (request.headers.get('X-Auth') !== env.CONTROL_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      var st = {};
      try { st = await request.json(); } catch (e) {}
      var stroke = {
        at: Date.now(),
        x0: clamp01(st.x0), y0: clamp01(st.y0),
        x1: clamp01(st.x1), y1: clamp01(st.y1),
        steps: Math.min(Math.max(+st.steps || 12, 1), 60),
      };
      await env.RAIN_KV.put('stir', JSON.stringify(stroke));
      return json({ ok: true });
    }

    if (path === '/stir' && request.method === 'GET') {
      var rawStir = await env.RAIN_KV.get('stir');
      return json(rawStir ? JSON.parse(rawStir) : { at: 0 });
    }

    // ---- frame capture ----
    if (path === '/capture' && request.method === 'POST') {
      if (request.headers.get('X-Auth') !== env.CONTROL_SECRET) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      await env.RAIN_KV.put('captureAt', String(Date.now()));
      return json({ ok: true });
    }

    if (path === '/capture' && request.method === 'GET') {
      var at = await env.RAIN_KV.get('captureAt');
      return json({ at: at ? +at : 0 });
    }

    if (path === '/frame' && request.method === 'POST') {
      var f = {};
      try { f = await request.json(); } catch (e) {}
      if (!f.dataUrl) return json({ ok: false, error: 'missing dataUrl' }, 400);
      await env.RAIN_KV.put('frame', JSON.stringify({ t: Date.now(), dataUrl: f.dataUrl }));
      return json({ ok: true });
    }

    if (path === '/frame' && request.method === 'GET') {
      var raw4 = await env.RAIN_KV.get('frame');
      return json(raw4 ? JSON.parse(raw4) : {});
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
