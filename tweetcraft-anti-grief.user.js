// ==UserScript==
// @name         TweetCraft Anti-Grief
// @namespace    https://tweetcraft.jai.vin
// @version      1.4.2
// @description  Protect a region: press 1-4 at four corners to define a cube, scan it into a snapshot, and later revert any grief (destroyed / changed / added blocks, fire, water and lava) back to the snapshot state.
// @match        https://tweetcraft.jai.vin/r/*
// @match        https://tweetcraft.jai.vin/play/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';
  if (window.__tcAntiGrief) return;
  window.__tcAntiGrief = true;

  const targetWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  const CFG = { speed: 20, maxVolume: 8000000 };
  const MAX_Y = 127;          // build height is 128, valid y = 1..127
  const DEFAULT_WORLD = 1024;

  // ────────────────────────────────────────────────────────────────────
  //  SNAPSHOT STORAGE
  //  A snapshot is the sparse list of every non-air block in the region,
  //  packed as (localIndex:uint32, id:uint8) and base64'd. Layers persist in
  //  localStorage; if a snapshot is too big to save it is kept in memory for
  //  this session only.
  // ────────────────────────────────────────────────────────────────────
  const SNAP_KEY = 'tc.antigrief.v1';
  const SNAP_EXT_KEY = 'tc.antigrief.ext.v1';
  let store = loadStore();

  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(SNAP_KEY));
      if (s && Array.isArray(s.snaps)) return s;
    } catch (e) { /* ignore */ }
    return { snaps: [] };
  }  function loadExtern() {
    try {
      const raw = localStorage.getItem(SNAP_EXT_KEY);
      if (!raw) return { ids: [], stubs: [] };
      const p = JSON.parse(raw);
      return { ids: Array.isArray(p.ids)?p.ids:[], stubs: Array.isArray(p.stubs)?p.stubs:[] };
    } catch (e) { return { ids: [], stubs: [] }; }
  }
  function saveExtern(ids, stubs) {
    try { localStorage.setItem(SNAP_EXT_KEY, JSON.stringify({ ids, stubs })); return true; } catch (e) { return false; }
  }

  // Only the persisted fields are written; the big in-memory `_pad` cache
  // must never reach localStorage.
  function serializable() {
    return {
      snaps: store.snaps.filter(s=>!externOnly.has(s.id)).map((s) => ({
        id: s.id, name: s.name, ts: s.ts,
        ox: s.ox, oy: s.oy, oz: s.oz, sx: s.sx, sy: s.sy, sz: s.sz,
        count: s.count, enc: s.enc,
      })),
    };
  }
  function saveStore() {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify(serializable())); return true; }
    catch (e) { return false; }
  }
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function nextName(base) {
    const names = store.snaps.map(x=>x.name);
    let n = base; let i = 1;
    while (names.includes(n)) n = base + " v" + (i++);
    return n;
  }

  function bytesToB64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // A dense per-cell byte pad (id per cell, 0 = air) is the runtime lookup:
  // one byte per cell regardless of how much of it is air, and O(1) reads.
  // The persisted form is the sparse list, base64'd, so mostly-air regions stay small.
  function padFromBlocks(blocks, sx, sy, sz) {
    const pad = new Uint8Array(sx * sy * sz);
    for (let i = 0; i < blocks.length; i += 4) {
      pad[(blocks[i] * sy + blocks[i + 1]) * sz + blocks[i + 2]] = blocks[i + 3] & 0xff;
    }
    return pad;
  }
  // dense pad → base64 string
  function encodePad(pad, sy, sz) {
    let count = 0;
    for (let i = 0; i < pad.length; i++) if (pad[i]) count++;
    const bytes = new Uint8Array(count * 5);
    const dv = new DataView(bytes.buffer);
    let p = 0;
    for (let i = 0; i < pad.length; i++) {
      const v = pad[i];
      if (!v) continue;
      dv.setUint32(p, i >>> 0, true); p += 4;
      dv.setUint8(p, v); p += 1;
    }
    return bytesToB64(bytes);
  }
  // base64 string → Int32Array flat [lx,ly,lz,id, ...]
  function decodeBlocks(b64, sy, sz) {
    const bytes = b64ToBytes(b64);
    const dv = new DataView(bytes.buffer);
    const n = Math.floor(bytes.length / 5);
    const out = new Int32Array(n * 4);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const idx = dv.getUint32(p, true); p += 4;
      const id = dv.getUint8(p); p += 1;
      const lz = idx % sz;
      const r = (idx - lz) / sz;
      const ly = r % sy;
      const lx = (r - ly) / sy;
      out[i * 4] = lx; out[i * 4 + 1] = ly; out[i * 4 + 2] = lz; out[i * 4 + 3] = id;
    }
    return out;
  }

  function snapPad(snap) {
    if (snap._pad) return snap._pad;
    snap._pad = padFromBlocks(decodeBlocks(snap.enc, snap.sy, snap.sz), snap.sx, snap.sy, snap.sz);
    return snap._pad;
  }

  // ────────────────────────────────────────────────────────────────────
  //  ENGINE BINDING  (works on DEV `__mc.eng` and on production WASM exports)
  // ────────────────────────────────────────────────────────────────────
  let wasmExports = null;
  const W = { x: null, names: [], nb: 0 };

  function cstr(p) {
    const b = new Uint8Array(wasmExports.memory.buffer);
    let q = p;
    while (b[q]) q++;
    return new TextDecoder().decode(b.subarray(p, q));
  }

  function captureWasm(result) {
    try {
      const inst = result && result.instance ? result.instance : result;
      const ex = inst && inst.exports;
      if (ex && typeof ex.set_block === 'function' && typeof ex.get_block === 'function') {
        wasmExports = ex;
        if (!W.x) { W.x = ex; W.mem = ex.memory; }
        if (!W.names.length && typeof ex.block_names === 'function') W.names = cstr(ex.block_names()).split('\n');
        if (!W.nb && typeof ex.nblocks === 'function') W.nb = ex.nblocks();
      }
    } catch (e) { /* ignore */ }
    return result;
  }
  function hookWasm(win) {
    if (!win.WebAssembly) return;
    for (const key of ['instantiate', 'instantiateStreaming']) {
      const orig = win.WebAssembly[key];
      if (!orig) continue;
      win.WebAssembly[key] = async function (...args) {
        const res = await orig.apply(this, args);
        return captureWasm(res);
      };
    }
  }

  function engX() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.x) return mc.eng.x;
    return W.x || (wasmExports || null);
  }
  function engState() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.st) return mc.eng.st;
    const x = engX();
    if (x && x.memory && typeof x.state_ptr === 'function') {
      return new Float64Array(x.memory.buffer, x.state_ptr(), 12);
    }
    if (wasmExports && wasmExports.memory && typeof wasmExports.state_ptr === 'function') {
      return new Float64Array(wasmExports.memory.buffer, wasmExports.state_ptr(), 12);
    }
    return null;
  }
  function engNames() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && Array.isArray(mc.eng.blockNames)) return mc.eng.blockNames;
    return W.names;
  }

  function fullAt(x, y, z) {
    const xw = engX();
    if (xw) { try { if (xw.get_full) return xw.get_full(x, y, z); if (xw.get_block) return xw.get_block(x, y, z); } catch (e) { /* ignore */ } }
    if (wasmExports) { try { if (wasmExports.get_full) return wasmExports.get_full(x, y, z); } catch (e) { /* ignore */ } }
    return -1;
  }
  function setBlock(x, y, z, id) {
    const xw = engX();
    if (xw && xw.set_block) { try { return xw.set_block(x, y, z, id); } catch (e) { return -1; } }
    if (wasmExports && wasmExports.set_block) { try { return wasmExports.set_block(x, y, z, id); } catch (e) { return -1; } }
    return -1;
  }
  function worldW() {
    const x = engX();
    if (x && typeof x.world_w === 'function') { try { return x.world_w(); } catch (e) { /* ignore */ } }
    if (wasmExports && wasmExports.world_w) { try { return wasmExports.world_w(); } catch (e) { /* ignore */ } }
    return DEFAULT_WORLD;
  }
  function worldH() {
    const x = engX();
    if (x && typeof x.world_h === 'function') { try { return x.world_h(); } catch (e) { /* ignore */ } }
    if (wasmExports && wasmExports.world_h) { try { return wasmExports.world_h(); } catch (e) { /* ignore */ } }
    return 128;
  }
  function nb() { return W.nb || (W.names && W.names.length) || 256; }
  const inWorld = (x, y, z) => x >= 0 && z >= 0 && x < worldW() && z < worldW() && y >= 1 && y < worldH();
  function validBlock(id) {
    if (!Number.isInteger(id) || id < 1 || id > 254) return false;
    const names = engNames();
    if (names && names.length && !names[id]) return false;
    return id < nb();
  }

  // ────────────────────────────────────────────────────────────────────
  //  BLOCK CLASSIFICATION (fluids / fire), detected from the block names
  // ────────────────────────────────────────────────────────────────────
  let FLUID_IDS = new Set();
  let FIRE_IDS = new Set();
  let stoneCache = null;
  let scaffoldCache = null;
  function classify() {
    const names = engNames();
    if (!names || !names.length) return;
    const fl = new Set(), fi = new Set();
    for (let i = 1; i < names.length && i < 256; i++) {
      const n = String(names[i] || '').toLowerCase().replace(/_/g, ' ');
      if (!n) continue;
      if (/water|lava/.test(n)) fl.add(i);
      if (/^fire$/.test(n) || /^soul fire$/.test(n)) fi.add(i);
    }
    if (fl.size) FLUID_IDS = fl;
    if (fi.size) FIRE_IDS = fi;
  }
  const isFluid = (id) => FLUID_IDS.has(id);
  // Fire is short-lived and about to be dug, so it must never act as support.
  const supports = (b) => b > 0 && b <= 254 && !FLUID_IDS.has(b) && !FIRE_IDS.has(b);

  function findIdByName(re, fallback) {
    const names = engNames();
    if (names) for (let i = 1; i < names.length && i < 256; i++) {
      const n = String(names[i] || '').toLowerCase().replace(/_/g, ' ').trim();
      if (re.test(n) && validBlock(i)) return i;
    }
    return fallback;
  }
  const stoneId = () => (stoneCache != null ? stoneCache : (stoneCache = findIdByName(/^stone$/, findIdByName(/cobblestone|stone/, 1))));
  const scaffoldId = () => (scaffoldCache != null ? scaffoldCache : (scaffoldCache = findIdByName(/^dirt$/, findIdByName(/^stone$/, 1))));

  // ────────────────────────────────────────────────────────────────────
  //  NETWORK  (capture the game socket and expose a sender)
  // ────────────────────────────────────────────────────────────────────
  const net = { ws: null, send: () => { }, synced: false, lock: 0, hotbar: null, slot: 0 };
  let capturedWS = null;

  function applySlot(st) {
    if (!st) return;
    if (Number.isInteger(st.slot) && st.slot >= 0 && st.slot <= 8) net.slot = st.slot;
    if (Array.isArray(st.hotbar) && st.hotbar.length === 9) net.hotbar = st.hotbar.slice();
  }
  function onMessage(m) {
    switch (m.t) {
      case 'welcome': net.synced = false; net.lock = (m.room && m.room.lock) || 0; applySlot(m.st); break;
      case 'synced': net.synced = true; break;
      case 'room': net.lock = (m.room && m.room.lock) || 0; break;
      case 'place': applySlot(m.st); break;
      case 'sys':
        if (m.m) { window.__tcAntiGrief.lastSys = m.m; if (job && /out of date/i.test(m.m)) job.abort = true; }
        break;
      case 'placeack':
      case 'digack':
        if (Number.isInteger(m.x) && Number.isInteger(m.y) && Number.isInteger(m.z) &&
          Number.isInteger(m.b) && m.b >= 0 && m.b <= 255) {
          try { setBlock(m.x, m.y, m.z, m.b); } catch (e) { /* ignore */ }
        }
        break;
    }
  }

  function attachSocket(ws) {
    if (!ws || capturedWS === ws) return;
    capturedWS = ws;
    net.ws = ws;
    net.synced = false;
    const raw = ws.send.bind(ws);
    net.send = (d) => { if (ws.readyState === 1) { try { raw(d); } catch (e) { /* ignore */ } } };
    ws.send = function (data) {
      if (typeof data === 'string' && data.charCodeAt(0) === 123) {
        try { const m = JSON.parse(data); if (m.t === 'inv') applySlot(m); } catch (e) { /* ignore */ }
      }
      return raw(data);
    };
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || e.data.charCodeAt(0) !== 123) return;
      let m; try { m = JSON.parse(e.data); } catch (e2) { return; }
      onMessage(m);
    });
    ws.addEventListener('close', () => { if (net.ws === ws) net.synced = false; });
  }

  function hookPrototypeSend(win) {
    const proto = win.WebSocket && win.WebSocket.prototype;
    if (!proto || proto.__agHooked) return;
    proto.__agHooked = true;
    const orig = proto.send;
    proto.send = function (data) {
      if (!capturedWS && this && typeof this.url === 'string' && this.url.includes('/ws/') && !this.url.includes('/voice/')) {
        attachSocket(this);
      }
      return orig.apply(this, arguments);
    };
  }
  function wrapWS(win) {
    const Orig = win.WebSocket;
    if (!Orig) return;
    const Wrapped = function (...args) {
      const ws = new Orig(...args);
      try {
        const url = String(args[0] || '');
        if (url.includes('/ws/') && !url.includes('/voice/')) attachSocket(ws);
      } catch (e) { /* ignore */ }
      return ws;
    };
    Wrapped.prototype = Orig.prototype;
    Wrapped.CONNECTING = Orig.CONNECTING;
    Wrapped.OPEN = Orig.OPEN;
    Wrapped.CLOSING = Orig.CLOSING;
    Wrapped.CLOSED = Orig.CLOSED;
    try { Object.assign(Wrapped, Orig); } catch (e) { /* ignore */ }
    win.WebSocket = Wrapped;
  }

  hookPrototypeSend(targetWindow);
  if (targetWindow !== window) hookPrototypeSend(window);
  wrapWS(targetWindow);
  if (targetWindow !== window) wrapWS(window);
  hookWasm(targetWindow);
  if (targetWindow !== window) hookWasm(window);

  // ────────────────────────────────────────────────────────────────────
  //  BUILD PROTOCOL  (current TweetCraft place/dig JSON protocol, ported
  //  from the known-good WorldEdit: spoof the player next to every change,
  //  place with p:[target], snapshot & restore the hotbar).
  // ────────────────────────────────────────────────────────────────────
  const netOp = { seq: 0, held: -1, realBar: null, realSlot: 0 };
  const FACE_N = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  const SUPPORT_ORDER = [1, 4, 5, 2, 3, 0];

  function hotbar() {
    const S = (targetWindow.__mc || window.__mc)?.S;
    if (S && Array.isArray(S.hotbar) && S.hotbar.length === 9) return S.hotbar.slice();
    try { const h = JSON.parse(localStorage.getItem('mc.hotbar')); if (Array.isArray(h) && h.length === 9) return h; } catch (e) { /* ignore */ }
    if (Array.isArray(net.hotbar) && net.hotbar.length === 9) return net.hotbar.slice();
    return [2, 3, 1, 4, 5, 6, 10, 11, 7];
  }
  function slotId() {
    const S = (targetWindow.__mc || window.__mc)?.S;
    if (S && Number.isInteger(S.slot) && S.slot >= 0 && S.slot <= 8) return S.slot;
    return net.slot;
  }

  function sendPos(x, y, z, flags = 2) {
    const buf = new ArrayBuffer(18);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setFloat32(1, x, true);
    dv.setFloat32(5, y, true);
    dv.setFloat32(9, z, true);
    dv.setInt16(13, 0, true);
    dv.setInt16(15, 0, true);
    dv.setUint8(17, flags);           // 2 = flying (server won't drag us down mid-edit)
    net.send(buf);
  }
  function sendRealPos() {
    const st = engState();
    if (!st) return;
    sendPos(st[0], st[1], st[2], 0);
  }
  function setHeldBlock(id) {
    if (netOp.held === id) return;
    if (netOp.held === -1) { netOp.realBar = hotbar(); netOp.realSlot = slotId(); }
    netOp.held = id;
    const hb = netOp.realBar.slice();
    hb[0] = id;
    net.send(JSON.stringify({ t: 'inv', hotbar: hb, slot: 0 }));
  }
  function restoreHeld() {
    if (netOp.held === -1) return;
    netOp.held = -1;
    const hb = netOp.realBar;
    if (!hb) return;
    netOp.realBar = null;
    net.send(JSON.stringify({ t: 'inv', hotbar: hb, slot: netOp.realSlot }));
  }

  function findSupport(x, y, z) {
    for (const f of SUPPORT_ORDER) {
      const n = FACE_N[f];
      const tx = x - n[0], ty = y - n[1], tz = z - n[2];
      if (!inWorld(tx, ty, tz)) continue;
      const b = fullAt(tx, ty, tz);
      if (supports(b)) return { tx, ty, tz, f };
    }
    return null;
  }
  function opDig(x, y, z) {
    netOp.seq++;
    sendPos(x + 0.5, Math.min(worldH() - 1, y + 3), z + 0.5);
    net.send(JSON.stringify({ t: 'dig', s: 0, x, y, z, f: 1, i: netOp.seq }));
  }
  function opPlace(x, y, z, id, sup) {
    netOp.seq++;
    setHeldBlock(id);
    sendPos(sup.tx + 0.5, Math.min(worldH() - 1, sup.ty + 3), sup.tz + 0.5);
    net.send(JSON.stringify({ t: 'place', x: sup.tx, y: sup.ty, z: sup.tz, f: sup.f, i: netOp.seq, p: [x, y, z] }));
  }
  // Apply one edit (local world already updated). Digging a fluid does nothing
  // server-side, so we never bother: placing the wanted block overwrites it.
  function netSet(x, y, z, old, to, sup) {
    if (old !== 0 && !isFluid(old)) opDig(x, y, z);
    if (to !== 0 && sup) opPlace(x, y, z, to, sup);
  }

  // ────────────────────────────────────────────────────────────────────
  //  SUPPORT PLANNER  (BFS out from edges + temporary pillars for floating
  //  cells; same algorithm as the WorldEdit, with fluids never counting as
  //  support so nothing ends up resting on water/lava).
  // ────────────────────────────────────────────────────────────────────
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const cellKey = (x, y, z) => ((x * 2048) + z) * 256 + y;

  function planOps(list) {
    const n = list.length / 4;
    const index = new Map();
    const overlay = new Map();
    const ops = [];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const x = list[o], y = list[o + 1], z = list[o + 2], to = list[o + 3];
      if (to === 0) { overlay.set(cellKey(x, y, z), 0); ops.push(x, y, z, 0, 0); }
      else index.set(cellKey(x, y, z), o);
    }
    if (!index.size) return Int32Array.from(ops);

    const solid = (x, y, z) => {
      const k = cellKey(x, y, z);
      const ov = overlay.get(k);
      if (ov !== undefined) return ov > 0;
      if (index.has(k)) return false;
      if (!inWorld(x, y, z)) return false;
      const b = fullAt(x, y, z);
      return supports(b);
    };
    const supported = (x, y, z) => {
      for (const d of N6) if (solid(x + d[0], y + d[1], z + d[2])) return true;
      return false;
    };

    const scafId = validBlock(scaffoldId()) ? scaffoldId() : 1;
    const pillar = [];

    const queue = [];
    for (const [k, o] of index) if (supported(list[o], list[o + 1], list[o + 2])) queue.push(k);

    let guard = index.size * 4 + 32;
    while (index.size && guard-- > 0) {
      if (queue.length) {
        const k = queue.pop();
        const o = index.get(k);
        if (o === undefined) continue;
        index.delete(k);
        const x = list[o], y = list[o + 1], z = list[o + 2], to = list[o + 3];
        overlay.set(k, to);
        ops.push(x, y, z, to, 0);
        for (const d of N6) {
          const nx = x + d[0], ny = y + d[1], nz = z + d[2];
          const nk = cellKey(nx, ny, nz);
          if (index.has(nk) && supported(nx, ny, nz)) queue.push(nk);
        }
      } else {
        let bestK = -1, bestY = 1e9, bestX = 1e9;
        for (const [k, o] of index) {
          const y = list[o + 1], x = list[o];
          if (y < bestY || (y === bestY && x < bestX)) { bestY = y; bestX = x; bestK = k; }
        }
        if (bestK < 0) break;
        const o = index.get(bestK);
        const x = list[o], y = list[o + 1], z = list[o + 2];
        let sy = -1;
        for (let yy = y - 1; yy >= 1; yy--) if (solid(x, yy, z)) { sy = yy; break; }
        if (sy < 0) { index.delete(bestK); continue; }
        for (let yy = sy + 1; yy < y; yy++) {
          if (index.has(cellKey(x, yy, z))) continue;   // a real block goes here later
          overlay.set(cellKey(x, yy, z), scafId);
          ops.push(x, yy, z, scafId, 1);
          pillar.push(x, yy, z);
        }
        queue.push(bestK);
      }
    }
    for (let s = pillar.length - 3; s >= 0; s -= 3) ops.push(pillar[s], pillar[s + 1], pillar[s + 2], 0, 1);
    return Int32Array.from(ops);
  }

  function concatI32(a, b) {
    if (!a.length) return b;
    if (!b.length) return a;
    const out = new Int32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // ────────────────────────────────────────────────────────────────────
  //  JOB RUNNER
  // ────────────────────────────────────────────────────────────────────
  let job = null;

  function startJob(label, list) {
    if (!list || !list.length) { toast(label + ': nothing to change', 2200); setStatus(label + ': nothing to change', 'warn'); return; }
    job = {
      label, list, i: 0, n: list.length / 5, log: [],
      skipped: 0, failed: 0, nosup: 0, abort: false,
      t0: performance.now(), lastToast: 0, acc: 0,
    };
    setStatus(label + '…', 'run');
    toast(label + ' started…', 1600);
    render();
  }

  function finish() {
    const j = job;
    job = null;
    sendRealPos();
    restoreHeld();
    const changed = j.log.length / 5;
    let msg = j.label + ': ' + changed + ' changed in ' + ((performance.now() - j.t0) / 1000).toFixed(1) + 's';
    if (j.skipped) msg += ', ' + j.skipped + ' skipped';
    if (j.nosup) msg += ', ' + j.nosup + ' unsupported';
    if (j.failed) msg += ', ' + j.failed + ' failed';
    setStatus(msg, (j.failed || j.nosup) ? 'warn' : 'ok');
    toast(j.label + ': ' + changed + ' blocks', 2600);
    render();
  }

  setInterval(() => {
    if (!job) return;
    if (!engX() || !net.ws || net.ws.readyState !== 1 || !net.synced) return;
    job.acc += Math.max(1, Math.min(20000, CFG.speed)) / 20;
    let per = Math.floor(job.acc);
    job.acc -= per;
    const L = job.list;
    let n = 0;
    while (n < per && job.i < job.n) {
      const o = job.i++ * 5;
      const x = L[o], y = L[o + 1], z = L[o + 2], to = L[o + 3], scaf = L[o + 4];
      if (to !== 0 && !validBlock(to)) { job.skipped++; continue; }
      if (!inWorld(x, y, z)) { job.skipped++; continue; }
      const old = fullAt(x, y, z);
      if (old === to) continue;
      if (old > 254) { job.skipped++; continue; }
      const sup = to !== 0 ? findSupport(x, y, z) : null;
      if (to !== 0 && !sup) { job.nosup++; continue; }
      if (setBlock(x, y, z, to) === -1) { job.failed++; continue; }
      netSet(x, y, z, old, to, sup);
      if (!scaf) job.log.push(x, y, z, old, to);
      n++;
    }
    const now = performance.now();
    if (now - job.lastToast > 250) {
      job.lastToast = now;
      setProgress(job.i / job.n);
    }
    if (job.i >= job.n || job.abort) finish();
  }, 50);

  // ────────────────────────────────────────────────────────────────────
  //  REGION + SNAPSHOT
  // ────────────────────────────────────────────────────────────────────
  const pts = [null, null, null, null];

  function region() {
    const ps = pts.filter(Boolean);
    if (ps.length < 2) return null;
    const fullHeight = !!(el('ag-height') && el('ag-height').checked);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of ps) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
    const Wd = worldW();
    lo[0] = Math.max(0, Math.min(Wd - 1, lo[0])); hi[0] = Math.max(0, Math.min(Wd - 1, hi[0]));
    lo[2] = Math.max(0, Math.min(Wd - 1, lo[2])); hi[2] = Math.max(0, Math.min(Wd - 1, hi[2]));
    if (fullHeight) {
      // two X/Z corners are enough: the column runs from the ground to the build limit
      lo[1] = 1; hi[1] = MAX_Y;
    } else {
      lo[1] = Math.max(1, Math.min(MAX_Y, lo[1])); hi[1] = Math.max(1, Math.min(MAX_Y, hi[1]));
    }
    const n = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    return { lo, hi, n };
  }

  function targetBlock() {
    const S = (targetWindow.__mc || window.__mc)?.S;
    if (S && S.sel && Number.isInteger(S.sel.x)) return [S.sel.x, S.sel.y, S.sel.z];
    return null;
  }
  function feet() {
    const st = engState();
    if (!st) return null;
    return [Math.floor(st[0]), Math.floor(st[1] + 1e-3), Math.floor(st[2])];
  }
  const aimedOrFeet = () => targetBlock() || feet();

  function setPoint(i, p) {
    if (!p) { toast('Look at a block or stand somewhere first', 1800); return; }
    const Wd = worldW();
    pts[i] = [
      Math.max(0, Math.min(Wd - 1, p[0] | 0)),
      Math.max(1, Math.min(MAX_Y, p[1] | 0)),
      Math.max(0, Math.min(Wd - 1, p[2] | 0)),
    ];
    toast('P' + (i + 1) + ' = ' + pts[i].join(', '), 1500);
    render();
  }

  let scanCancel = false;
  let busy = false;
  async function scanRegion(lo, hi, onProg) {
    classify();
    const sx = hi[0] - lo[0] + 1, sy = hi[1] - lo[1] + 1, sz = hi[2] - lo[2] + 1;
    const total = sx * sy * sz;
    const pad = new Uint8Array(total);
    let count = 0, done = 0;
    const CHUNK = 60000;
    for (let x = lo[0]; x <= hi[0]; x++) {
      for (let y = lo[1]; y <= hi[1]; y++) {
        for (let z = lo[2]; z <= hi[2]; z++) {
          const v = fullAt(x, y, z);
          // 0 = air, 255 = out of range/unknown: only keep real, placeable blocks
          if (v > 0 && v <= 254) { pad[((x - lo[0]) * sy + (y - lo[1])) * sz + (z - lo[2])] = v; count++; }
          if (++done % CHUNK === 0) {
            if (onProg) onProg(done, total);
            if (scanCancel) throw new Error('cancelled');
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      }
    }
    if (onProg) onProg(total, total);
    return { pad, sx, sy, sz, count, total };
  }

  async function doScan() {
    if (!ready()) return;
    const r = region();
    if (!r) { toast('Set at least two region points first', 2200); return; }
    if (r.n > CFG.maxVolume) { toast('Region too big (' + fmt(r.n) + '). Raise “Max region” in Options or shrink the box.', 3200); return; }
    const name = (el('ag-name').value || '').trim() || ('Snapshot ' + (store.snaps.length + 1));
    scanCancel = false;
    busy = true;
    setStatus('Scanning ' + fmt(r.n) + ' blocks…', 'run');
    setProgress(0);
    render();
    try {
      const res = await scanRegion(r.lo, r.hi, (d, t) => setProgress(d / t));
      const snap = {
        id: uid(), name, ts: Date.now(),
        ox: r.lo[0], oy: r.lo[1], oz: r.lo[2],
        sx: res.sx, sy: res.sy, sz: res.sz,
        count: res.count,
        enc: encodePad(res.pad, res.sy, res.sz),
      };
      snap._pad = res.pad;
      store.snaps.unshift(snap);
      let saved = saveStore();
      if (!saved) {
        externOnly.add(snap.id);
        saveStore();
        try {
          const stubs = store.snaps.filter(x=>externOnly.has(x.id)).map(x=>({id:x.id,name:x.name,ts:x.ts,ox:x.ox,oy:x.oy,oz:x.oz,sx:x.sx,sy:x.sy,sz:x.sz,count:x.count}));
          saveExtern(Array.from(externOnly), stubs);
          exportSnapshot(snap);
        } catch (e) {}
      }
      el('ag-name').value = '';
      setProgress(0);
      setStatus('Saved "' + name + '" (' + fmt(snap.count) + ' blocks)' + (saved ? '' : ' — too big for localStorage; exported as JSON (needed to restore)'), saved ? 'ok' : 'warn');
      toast('Snapshot "' + name + '" saved', 2200);
    } catch (e) {
      setProgress(0);
      setStatus('Scan ' + (e && e.message === 'cancelled' ? 'cancelled' : 'failed'), 'warn');
    }
    scanCancel = false;
    busy = false;
    render();
  }

  const memoryOnly = new Set();
  const externOnly = new Set();
  const _ext = loadExtern();
  for (const id of _ext.ids) externOnly.add(id);
  if (_ext.stubs.length) {
    const m = new Set(store.snaps.map(x=>x.id));
    for (const st of _ext.stubs) { if (!m.has(st.id)) { store.snaps.push(st); m.add(st.id); }
    }
  }
  function keepInMemoryOnly(snap) {
    memoryOnly.add(snap.id);
    // roll back the persisted copy so localStorage never holds the oversized blob
    store.snaps = store.snaps.filter((s) => s.id !== snap.id);
    saveStore();
    store.snaps.unshift(snap);
  }

  async function updateSnapshot(snap) {
    if (!ready()) return;
    const lo = [snap.ox, snap.oy, snap.oz];
    const hi = [snap.ox + snap.sx - 1, snap.oy + snap.sy - 1, snap.oz + snap.sz - 1];
    scanCancel = false;
    busy = true;
    setStatus('Updating "' + snap.name + '"…', 'run');
    setProgress(0);
    try {
      const res = await scanRegion(lo, hi, (d, t) => setProgress(d / t));
      snap.count = res.count;
      snap.ts = Date.now();
      snap.enc = encodePad(res.pad, res.sy, res.sz);
      snap._pad = res.pad;
      let saved = saveStore();
      if (!saved) {
        externOnly.add(snap.id);
        saveStore();
        try {
          const stubs = store.snaps.filter(x=>externOnly.has(x.id)).map(x=>({id:x.id,name:x.name,ts:x.ts,ox:x.ox,oy:x.oy,oz:x.oz,sx:x.sx,sy:x.sy,sz:x.sz,count:x.count}));
          saveExtern(Array.from(externOnly), stubs);
          exportSnapshot(snap);
        } catch (e) {}
      }
      setProgress(0);
      setStatus('Updated "' + snap.name + '" (' + fmt(snap.count) + ' blocks)' + (saved ? '' : ' — too big; exported JSON (needed to restore)'), saved ? 'ok' : 'warn');
    } catch (e) {
      setProgress(0);
      setStatus('Update ' + (e && e.message === 'cancelled' ? 'cancelled' : 'failed'), 'warn');
    }
    scanCancel = false;
    busy = false;
    render();
  }

  // ────────────────────────────────────────────────────────────────────
  //  REVERT
  //  Two phases in a single ordered list:
  //    1. place every block the snapshot wants (restoring solids, and standing
  //       in a temporary solid over any fluid that must become air);
  //    2. dig everything that must end up as air — fire, the griefer's extra
  //       blocks, and the temporary solids over former fluids.
  // ────────────────────────────────────────────────────────────────────
  async function revert(snap) {
    if (!ready()) return;
    const removeExtra = el('ag-remove').checked;
    const support = el('ag-support').checked;
    classify();
    const pad = snapPad(snap);
    const lo = [snap.ox, snap.oy, snap.oz];
    const hi = [snap.ox + snap.sx - 1, snap.oy + snap.sy - 1, snap.oz + snap.sz - 1];

    const place = [];   // flat 4-tuples to place
    const remove = [];  // flat triples to dig to air
    let changed = 0, unsupported = 0, done = 0;
    const total = (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1);
    const CHUNK = 60000;

    scanCancel = false;
    busy = true;
    setStatus('Comparing ' + fmt(total) + ' blocks…', 'run');
    setProgress(0);
    try {
      for (let x = lo[0]; x <= hi[0]; x++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let z = lo[2]; z <= hi[2]; z++) {
            const cur = fullAt(x, y, z);
            if (cur >= 0 && cur <= 254) {
              const idx = ((x - snap.ox) * snap.sy + (y - snap.oy)) * snap.sz + (z - snap.oz);
              const want = pad[idx];
              if (cur !== want) {
                if (want !== 0) {
                  if (validBlock(want)) { place.push(x, y, z, want); changed++; }
                  else unsupported++;
                } else if (removeExtra) {
                  if (isFluid(cur)) place.push(x, y, z, stoneId());  // stand in a solid first
                  remove.push(x, y, z);
                  changed++;
                }
              }
            }
            if (++done % CHUNK === 0) {
              setProgress(done / total);
              if (scanCancel) throw new Error('cancelled');
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        }
      }
    } catch (e) {
      busy = false;
      setProgress(0);
      setStatus('Revert ' + (e && e.message === 'cancelled' ? 'cancelled' : 'failed'), 'warn');
      return;
    }
    busy = false;
    setProgress(0);

    if (!place.length && !remove.length) {
      setStatus('"' + snap.name + '": already matches the snapshot', 'ok');
      toast('Nothing to revert', 2000);
      return;
    }

    const phase1 = support ? planOps(Int32Array.from(place)) : plainOps(place);
    const rem = [];
    for (let i = 0; i < remove.length; i += 3) rem.push(remove[i], remove[i + 1], remove[i + 2], 0, 0);
    const list = concatI32(phase1, Int32Array.from(rem));

    let label = 'revert "' + snap.name + '" (' + fmt(changed) + ' blocks)';
    if (unsupported) label += ' [' + fmt(unsupported) + ' unsupported]';
    startJob(label, list);
  }

  // Placements emitted in the given order (no support planning).
  function plainOps(place) {
    const out = [];
    for (let i = 0; i < place.length; i += 4) out.push(place[i], place[i + 1], place[i + 2], place[i + 3], 0);
    return Int32Array.from(out);
  }

  // ────────────────────────────────────────────────────────────────────
  //  READINESS + UI HELPERS
  // ────────────────────────────────────────────────────────────────────
  function ready() {
    if (!engX()) { toast('Engine not ready — reload the page', 2400); return false; }
    if (!engNames().length) { toast('Block data not loaded yet — wait for the world', 2400); return false; }
    if (!capturedWS || capturedWS.readyState !== 1) { toast('Not connected to the world yet', 2400); return false; }
    if (!net.synced) { toast('Waiting for the world to sync…', 2400); return false; }
    if (job) { toast('Busy: ' + job.label, 2000); return false; }
    if (busy) { toast('Busy scanning…', 2000); return false; }
    return true;
  }

  function toast(text, ms = 1800) {
    try {
      const n = document.getElementById('note');
      if (!n) return;
      n.textContent = text;
      n.classList.add('show');
      clearTimeout(toast.t);
      toast.t = setTimeout(() => n.classList.remove('show'), ms);
    } catch (e) { /* ignore */ }
  }
  const el = (id) => document.getElementById(id);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');

  function setStatus(text, kind) {
    const s = el('ag-status');
    if (!s) return;
    s.textContent = text;
    s.className = 'ag-status ag-' + (kind || 'idle');
  }
  function setProgress(frac) {
    const bar = el('ag-progress-bar');
    if (bar) bar.style.width = Math.max(0, Math.min(1, frac)) * 100 + '%';
  }
  function updateDot() {
    const d = el('ag-dot');
    if (!d) return;
    let kind = 'bad';
    if (engX() && capturedWS && capturedWS.readyState === 1 && net.synced) kind = 'ok';
    else if (engX() || capturedWS) kind = 'warn';
    d.className = 'ag-dot ag-' + kind;
    d.title = kind === 'ok' ? 'Ready' : kind === 'warn' ? 'Connecting…' : 'Not connected';
  }

  // ────────────────────────────────────────────────────────────────────
  //  KEYBOARD  (1-4 set the region corners while playing)
  // ────────────────────────────────────────────────────────────────────
  const locked = () => document.pointerLockElement === el('gl');
  const chatOpen = () => { const c = el('chatbox'); return !!c && !c.hidden; };
  const active = () => locked() && !chatOpen();

  addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^Digit[1-4]$/.test(e.code)) return;
    if (!active()) return;
    const box = el('ag-keys');
    if (box && !box.checked) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setPoint(Number(e.code[5]) - 1, aimedOrFeet());
  }, true);

  // ────────────────────────────────────────────────────────────────────
  //  UI
  // ────────────────────────────────────────────────────────────────────
  function renderPoints() {
    const host = el('ag-points');
    if (!host) return;
    host.innerHTML = '';
    const labels = ['1', '2', '3', '4'];
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('div');
      row.className = 'ag-prow';
      const p = pts[i];
      row.innerHTML =
        '<span class="ag-plabel">P' + (i + 1) + '</span>' +
        '<input class="ag-c" data-i="' + i + '" data-a="0" type="number" value="' + (p ? p[0] : '') + '" placeholder="x">' +
        '<input class="ag-c" data-i="' + i + '" data-a="1" type="number" value="' + (p ? p[1] : '') + '" placeholder="y">' +
        '<input class="ag-c" data-i="' + i + '" data-a="2" type="number" value="' + (p ? p[2] : '') + '" placeholder="z">' +
        '<button class="ag-set" data-i="' + i + '" title="Set P' + (i + 1) + ' at the block you are aiming at (or your feet)">' + labels[i] + '</button>';
      host.appendChild(row);
    }
    host.querySelectorAll('.ag-set').forEach((b) => {
      b.addEventListener('click', () => setPoint(+b.dataset.i, aimedOrFeet()));
    });
    host.querySelectorAll('.ag-c').forEach((inp) => {
      inp.addEventListener('change', () => {
        const i = +inp.dataset.i, a = +inp.dataset.a;
        if (!pts[i]) pts[i] = [0, 1, 0];
        const v = parseInt(inp.value, 10);
        if (Number.isFinite(v)) pts[i][a] = v;
        render();
      });
    });
  }

  function renderDims() {
    const d = el('ag-dims');
    if (!d) return;
    const r = region();
    const set = pts.filter(Boolean).length;
    if (!r) { d.textContent = 'No region — set ' + (2 - set) + ' more point(s) (press 1-4 while playing)'; return; }
    const fullHeight = !!(el('ag-height') && el('ag-height').checked);
    const over = r.n > CFG.maxVolume;
    d.textContent = (r.hi[0] - r.lo[0] + 1) + ' × ' + (r.hi[1] - r.lo[1] + 1) + ' × ' + (r.hi[2] - r.lo[2] + 1) +
      ' = ' + fmt(r.n) + ' blocks   (' + set + '/4 points' + (fullHeight ? ', full height' : '') + ')' +
      (over ? '  ⚠ over ' + fmt(CFG.maxVolume) + ' — raise Max region' : '');
  }

  function renderList() {
    const host = el('ag-list');
    if (!host) return;
    const count = el('ag-count');
    if (count) count.textContent = store.snaps.length;
    host.innerHTML = '';
    if (!store.snaps.length) {
      host.innerHTML = '<div class="ag-empty">No snapshots yet. Define a region and press “Scan &amp; Save”.</div>';
      return;
    }
    for (const s of store.snaps) {
      const row = document.createElement('div');
      row.className = 'ag-srow';
      const when = new Date(s.ts).toLocaleString();
      const mem = memoryOnly.has(s.id) ? ' · memory only' : '';
      const ext = externOnly.has(s.id) ? ' · ⚠ external JSON only (backup required to restore)' : '';
      row.innerHTML =
        '<div class="ag-sinfo">' +
        '<div class="ag-sname" title="' + esc(s.name) + '">' + esc(s.name) + '</div>' +
        '<div class="ag-smeta">' + s.sx + '×' + s.sy + '×' + s.sz + ' · ' + fmt(s.count) + ' blocks · ' + when + mem + ext + '</div>' +
        '</div>' +
        '<div class="ag-sbtns">' +
        '<button class="ag-act ag-rev" title="Revert the region to this snapshot">↩ Revert</button>' +
        '<button class="ag-act ag-upd" title="Re-scan the same region and overwrite this snapshot">↻</button>' +
        '<button class="ag-act ag-ren" title="Rename">✎</button>' +
        '<button class="ag-act ag-exp" title="Export as JSON backup">💾 Export</button>' +
        '<button class="ag-act ag-del" title="Delete">✕</button>' +
        '</div>';
      row.querySelector('.ag-rev').addEventListener('click', async () => {
        if (externOnly.has(s.id)) {
          toast('This snapshot requires the exported JSON. Select Import JSON to load it first.', 3200);
          if (confirm('Import JSON for snapshot "' + s.name + '"?')) {
            await importBackup();
          }
          return;
        }
        const msg = 'WARNING: EVERYTHING (NEW) SINCE THE SNAPSHOT WILL BE GONE\n\nSnapshot: "' + s.name + '" (' + new Date(s.ts).toLocaleString() + ')\n\nAre you sure you want to REVERT to this snapshot?';
        if (confirm(msg)) revert(s);
      });
      row.querySelector('.ag-upd').addEventListener('click', () => {
        if (externOnly.has(s.id)) {
          toast('This snapshot is external. Updating will export a new JSON.', 2200);
        }
        if (confirm('WARNING: This will OVERWRITE the snapshot with current blocks.\n\nContinue?')) updateSnapshot(s);
      });
      row.querySelector('.ag-ren').addEventListener('click', () => {
        const n = prompt('Snapshot name:', s.name);
        if (n != null) { s.name = n.trim() || s.name; saveStore(); render(); }
      });
      row.querySelector('.ag-del').addEventListener('click', () => {
        if (!confirm('WARNING: Delete snapshot "' + s.name + '" permanently?\n\n(This cannot be undone unless you have an exported JSON backup.)')) return;
        store.snaps = store.snaps.filter((x) => x.id !== s.id);
        memoryOnly.delete(s.id);
        externOnly.delete(s.id);
        saveStore();
        try { const stubs = store.snaps.filter(x=>externOnly.has(x.id)).map(x=>({id:x.id,name:x.name,ts:x.ts,ox:x.ox,oy:x.oy,oz:x.oz,sx:x.sx,sy:x.sy,sz:x.sz,count:x.count})); saveExtern(Array.from(externOnly), stubs); } catch(e){}
        render();
      });
      if (row.querySelector('.ag-exp')) row.querySelector('.ag-exp').addEventListener('click', () => exportSnapshot(s));
      host.appendChild(row);
    }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render() {
    renderPoints();
    renderDims();
    renderList();
    updateDot();
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.id = 'ag-panel';
    panel.innerHTML = `
      <div id="ag-head">
        <span class="ag-title">🛡️ Anti-Grief</span>
        <span id="ag-dot" class="ag-dot"></span>
        <button id="ag-collapse" title="Collapse">–</button>
      </div>
      <div id="ag-body">
        <div class="ag-sec">
          <div class="ag-h">Region</div>
          <div id="ag-points"></div>
          <div id="ag-dims" class="ag-hint">No region</div>
          <div class="ag-hint">Press 1–4 to set corners. With Full height on, two opposite X/Z corners are enough.</div>
          <div class="ag-row"><button id="ag-clear">Clear points</button></div>
        </div>
        <div class="ag-sec">
          <div class="ag-h">Snapshot</div>
          <div class="ag-row"><input id="ag-name" placeholder="Snapshot name"><button id="ag-scan">📸 Scan &amp; Save</button></div>
          <div class="ag-hint">Load the region in view first — unloaded chunks read as air.</div>
        </div>
        <div class="ag-sec">
          <div class="ag-h">Snapshots <span id="ag-count" class="ag-badge">0</span></div>
          <div class="ag-row"><button id="ag-new">+ New Snapshot</button></div>
          <div id="ag-list" class="ag-list"></div>
        </div>
        <div class="ag-sec">
          <div class="ag-h">Options</div>
          <label class="ag-check"><input type="checkbox" id="ag-keys" checked> Keys 1–4 set region points</label>
          <label class="ag-check"><input type="checkbox" id="ag-height" checked> Full height — scan the whole column (y 1–127)</label>
          <label class="ag-check"><input type="checkbox" id="ag-remove" checked> Remove blocks added by the griefer</label>
          <label class="ag-check"><input type="checkbox" id="ag-support" checked> Auto-support floating blocks (scaffold)</label>
          <div class="ag-row"><span class="ag-lbl">Speed</span><input id="ag-speed" type="number" value="20" min="1" max="2000" step="1"><span class="ag-hint">blocks/s</span></div>
          <div class="ag-row"><span class="ag-lbl">Max region</span><input id="ag-maxv" type="number" value="8000000" min="10000" max="100000000" step="100000"><span class="ag-hint">cells</span></div>
          <div class="ag-row"><button id="ag-exportall">Export All JSON</button><button id="ag-import">Import JSON</button></div>
        </div>
        <div id="ag-progress"><div id="ag-progress-bar"></div></div>
        <div id="ag-status" class="ag-status ag-idle">Idle</div>
        <div class="ag-row"><button id="ag-cancel">Cancel</button></div>
      </div>`;
    document.body.appendChild(panel);

    el('ag-scan').addEventListener('click', doScan);
    el('ag-clear').addEventListener('click', () => { pts[0] = pts[1] = pts[2] = pts[3] = null; render(); });
    if (el('ag-new')) el('ag-new').addEventListener('click', () => doScan());
    el('ag-cancel').addEventListener('click', () => {
      scanCancel = true;
      if (job) { job.abort = true; job.i = job.n; }
      setStatus('Cancelling…', 'warn');
    });
    el('ag-speed').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      CFG.speed = Number.isFinite(v) ? Math.max(1, Math.min(20000, v)) : 20;
      e.target.value = CFG.speed;
    });
    el('ag-maxv').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      CFG.maxVolume = Number.isFinite(v) ? Math.max(10000, Math.min(100000000, v)) : 8000000;
      e.target.value = CFG.maxVolume;
      renderDims();
    });
    el('ag-height').addEventListener('change', render);
    if (el('ag-exportall')) el('ag-exportall').addEventListener('click', exportBackupAll);
    if (el('ag-import')) el('ag-import').addEventListener('click', importBackup);
    el('ag-collapse').addEventListener('click', () => {
      const body = el('ag-body');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      el('ag-collapse').textContent = hidden ? '–' : '+';
    });

    // drag by the header
    const head = el('ag-head');
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.id === 'ag-collapse') return;
      drag = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      panel.style.left = Math.max(0, e.clientX - drag.x) + 'px';
      panel.style.top = Math.max(0, e.clientY - drag.y) + 'px';
      panel.style.right = 'auto';
    });
    head.addEventListener('pointerup', (e) => { drag = null; try { head.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ } });
  }

  const CSS = `
    #ag-panel { position: fixed; top: 16px; right: 16px; width: 320px; max-height: 92vh; overflow: hidden;
      display: flex; flex-direction: column; z-index: 2147483600; color: #e8eaf0; font: 12px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
      background: rgba(18,20,28,0.94); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5); backdrop-filter: blur(8px); }
    #ag-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: grab;
      background: linear-gradient(90deg, rgba(20,184,166,0.25), rgba(20,184,166,0.05)); border-bottom: 1px solid rgba(255,255,255,0.08); }
    #ag-head:active { cursor: grabbing; }
    .ag-title { font-weight: 700; font-size: 13px; }
    #ag-collapse { margin-left: auto; width: 22px; height: 22px; border: none; border-radius: 6px; cursor: pointer;
      background: rgba(255,255,255,0.08); color: #e8eaf0; font-size: 14px; line-height: 1; }
    .ag-dot { width: 9px; height: 9px; border-radius: 50%; background: #ef4444; }
    .ag-dot.ag-ok { background: #22c55e; } .ag-dot.ag-warn { background: #f59e0b; } .ag-dot.ag-bad { background: #ef4444; }
    #ag-body { overflow-y: auto; padding: 10px 12px 12px; }
    .ag-sec { margin-bottom: 12px; }
    .ag-h { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #9aa3b2; margin-bottom: 6px; }
    .ag-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(20,184,166,0.3); color: #99f6e4; }
    .ag-hint { font-size: 10.5px; color: rgba(255,255,255,0.5); margin-top: 4px; }
    .ag-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    .ag-prow { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
    .ag-plabel { width: 22px; font-weight: 700; color: #7dd3fc; }
    .ag-c { width: 100%; min-width: 0; padding: 3px 4px; font-size: 11px; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12); border-radius: 5px; color: #e8eaf0; }
    #ag-panel button { padding: 5px 10px; font-size: 11px; border: none; border-radius: 6px;
      background: rgba(255,255,255,0.1); color: #e8eaf0; cursor: pointer; }
    #ag-panel #ag-collapse { margin-left: auto; width: 22px; height: 22px; padding: 0; font-size: 14px; line-height: 1; }
    #ag-panel .ag-set { width: 24px; flex: 0 0 auto; padding: 3px 0; background: rgba(56,189,248,0.25); color: #bae6fd; font-weight: 700; }
    #ag-scan { background: rgba(20,184,166,0.35) !important; color: #ccfbf1 !important; font-weight: 600 !important; }
    #ag-name, #ag-speed { padding: 5px 8px; font-size: 11px; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px; color: #e8eaf0; }
    #ag-name { flex: 1 1 auto; min-width: 0; }
    #ag-speed { width: 64px; }
    .ag-lbl { color: #9aa3b2; }
    .ag-check { display: flex; align-items: center; gap: 7px; font-size: 11.5px; padding: 3px 0; color: #cbd5e1; }
    .ag-empty { font-size: 11px; color: rgba(255,255,255,0.4); padding: 6px 0; }
    .ag-srow { display: flex; align-items: center; gap: 8px; padding: 7px 8px; margin-bottom: 5px;
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; }
    .ag-sinfo { flex: 1 1 auto; min-width: 0; }
    .ag-sname { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ag-smeta { font-size: 10px; color: rgba(255,255,255,0.45); }
    .ag-sbtns { display: flex; gap: 3px; flex: 0 0 auto; }
    #ag-panel .ag-act { width: 26px; height: 26px; padding: 0 !important; font-size: 12px !important; display: inline-flex;
      align-items: center; justify-content: center; }
    #ag-panel .ag-rev { width: auto; padding: 0 8px !important; background: rgba(34,197,94,0.25); color: #bbf7d0; }
    #ag-panel .ag-del { background: rgba(239,68,68,0.22); color: #fecaca; }
    #ag-progress { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.08); overflow: hidden; margin-top: 4px; }
    #ag-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg,#14b8a6,#38bdf8); transition: width .12s linear; }
    .ag-status { font-size: 11px; margin-top: 6px; color: #9aa3b2; word-break: break-word; }
    .ag-status.ag-ok { color: #86efac; } .ag-status.ag-warn { color: #fcd34d; } .ag-status.ag-run { color: #7dd3fc; }
  `;

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    buildPanel();
    classify();
    render();
    setInterval(() => { updateDot(); if (!job) renderDims(); }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  async function exportBackupAll() {
    const d = serializable();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tsn = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url; a.download = `antigrief-all-${tsn}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("All snapshots exported", 2000);
  }
  function exportSnapshot(s) {
    const d = { snaps: [{ id: s.id, name: s.name, ts: s.ts, ox: s.ox, oy: s.oy, oz: s.oz, sx: s.sx, sy: s.sy, sz: s.sz, count: s.count, enc: s.enc }] };
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const tsn = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url; a.download = `antigrief-${s.id||tsn}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Snapshot exported as JSON", 2000);
  }
  async function importBackup() {
    if (busy) return;
    busy = true;
    setStatus("Importing…", "run");
    const t = await new Promise(r => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "application/json";
      inp.onchange = () => {
        const f = inp.files && inp.files[0];
        if (!f) return r(null);
        const fr = new FileReader();
        fr.onload = e => r(e.target.result);
        fr.onerror = () => r(null);
        fr.readAsText(f);
      };
      inp.click();
    });
    if (!t) { busy = false; setStatus("Import cancelled", "warn"); return; }
    try {
      const p = JSON.parse(t);
      if (p && Array.isArray(p.snaps)) {
        const m = new Set(store.snaps.map(x => x.id));
        let c = 0;
        for (const s of p.snaps) {
          if (!m.has(s.id) && s.enc) {
            const n = { id: s.id || uid(), name: s.name || "Imported", ts: s.ts || Date.now(), ox: s.ox|0, oy: s.oy|0, oz: s.oz|0, sx: s.sx|0, sy: s.sy|0, sz: s.sz|0, count: s.count||0, enc: s.enc };
            store.snaps.push(n); m.add(n.id); c++;
          }
        }
        saveStore();
        render();
        setStatus(`Imported ${c} snapshots`, "ok");
        toast("Imported", 2000);
      } else throw 0;
    } catch (e) { setStatus("Import failed", "warn"); }
    busy = false;
  }
})();
