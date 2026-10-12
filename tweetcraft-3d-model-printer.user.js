// ==UserScript==
// @name         TweetCraft 3D Model Printer
// @namespace    https://tweetcraft.jai.vin
// @version      1.2.0
// @description  Upload a 3D model (OBJ/MTL, STL, GLB or FBX) → voxelize it → print it into your TweetCraft world as real blocks. Respects the 128-block max build height.
// @author       @vibecodingonsol
// @match        https://tweetcraft.jai.vin/r/*
// @match        https://tweetcraft.jai.vin/play/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const targetWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* ─────────────────────────────────────────────
   * 1. EARLY INTERCEPTIONS (WebSocket & WASM)
   * ───────────────────────────────────────────── */
  let capturedWS = null;
  let activePrinter = null;
  let roomInfo = { name: '', lock: 0, mode: 'creative' };
  let playerInfo = { id: 0, name: '', handle: '', verified: false };
  let packetsSentCount = 0;

  /* ─────────────────────────────────────────────
   * SERVER-ACKNOWLEDGED BLOCK STATE
   * ─────────────────────────────────────────────
   * The local WASM world is updated optimistically the moment we send an
   * edit, so `get_block()` can never reveal an edit the server dropped.
   * The server tells us the truth through binary frames:
   *   t=3 : bulk sync of the room's edits   (key:u32, block:u8)*
   *   t=4 : single authoritative set       key:u32, block:u8  (255 = DENIED)
   *   t=5/6: relay of this tick's edits     pos*(19) + (id:u16, key:u32, block:u8)*
   * We mirror those here so verification/retry reflects the real world.
   */
  const SERVER_DENY = 255;
  const serverEdits = new Map(); // key (u32) -> blockId the server has
  const sentEdits = new Map();   // key (u32) -> blockId we last asked the server to set

  function editKey(x, y, z) {
    return (((x << 17) | (z << 7) | y) >>> 0);
  }

  function ingestServerEdits(data) {
    let dv;
    try {
      if (data instanceof ArrayBuffer) dv = new DataView(data);
      else if (data && data.buffer instanceof ArrayBuffer) dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      else return;
    } catch (e) { return; }
    if (dv.byteLength < 1) return;
    const t = dv.getUint8(0);
    if (t === 3) {
      const n = Math.floor((dv.byteLength - 1) / 5);
      for (let i = 0; i < n; i++) {
        const o = 1 + i * 5;
        serverEdits.set(dv.getUint32(o, true), dv.getUint8(o + 4));
      }
    } else if (t === 4) {
      if (dv.byteLength >= 6) serverEdits.set(dv.getUint32(1, true), dv.getUint8(5));
    } else if (t === 5 || t === 6) {
      if (dv.byteLength < 5) return;
      const np = dv.getUint16(1, true);
      const ne = dv.getUint16(3, true);
      let o = 5 + np * 19;
      for (let i = 0; i < ne; i++, o += 7) {
        if (o + 7 > dv.byteLength) break;
        serverEdits.set(dv.getUint32(o + 2, true), dv.getUint8(o + 6));
      }
    }
  }

  const OrigWS = targetWindow.WebSocket || window.WebSocket;

  function isGameSocket(ws) {
    const url = String((ws && ws.url) || '');
    return url.includes('/ws/') && !url.includes('/voice/');
  }

  function captureSocket(ws, reason) {
    if (!ws || !isGameSocket(ws)) return false;
    const prev = capturedWS;
    if (prev === ws) return true;
    if (prev && (prev.readyState === 0 || prev.readyState === 1)) return false;
    capturedWS = ws;
    console.log('[Model3D] Captured game WebSocket (' + reason + '):', ws.url);
    attachSocketListeners(ws);
    updateStatusUI();
    return true;
  }

  function attachSocketListeners(ws) {
    if (!ws || ws._model3dMonitored) return;
    ws._model3dMonitored = true;
    try { ws.binaryType = 'arraybuffer'; } catch (e) { /* ignore */ }

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'welcome' && msg.room && msg.id !== undefined) {
            if (capturedWS !== ws) {
              capturedWS = ws;
              console.log('[Model3D] Confirmed game WebSocket via welcome message:', ws.url);
              updateStatusUI();
            }
            roomInfo.name = (msg.room && msg.room.name) || '';
            roomInfo.lock = msg.room && msg.room.lock != null ? msg.room.lock : 0;
            roomInfo.mode = (msg.room && msg.room.mode) || 'creative';
            playerInfo.id = msg.id || 0;
            playerInfo.name = (msg.you && msg.you.name) || '';
            playerInfo.handle = (msg.you && msg.you.h) || '';
            playerInfo.verified = !!((msg.you && msg.you.h) || msg.owner);
            updateStatusUI();
          }
          if (msg.t === 'sys') {
            console.warn('[Model3D] Server system message:', msg.m);
            updateStatusUI();
            if (activePrinter && activePrinter.running) {
              if (msg.m.includes('Verify') || msg.m.includes('build') || msg.m.includes('permission')) {
                activePrinter.stop();
                alert(
                  '⚠️ SERVER REJECTED BLOCK PLACEMENT:\n\n' +
                  `"${msg.m}"\n\n` +
                  'The server rejected your build packet. If this world is locked, verify your 𝕏 account (press V in-game).'
                );
              }
            }
          }
        } catch (err) { /* non-JSON frame */ }
      } else {
        ingestServerEdits(event.data);
      }
    });

    ws.addEventListener('close', () => {
      if (capturedWS === ws) capturedWS = null;
      updateStatusUI();
    });
  }

  const wrapConstructor = (win) => {
    const NativeWS = win.WebSocket;
    if (!NativeWS) return;
    win.WebSocket = function (...args) {
      const ws = new NativeWS(...args);
      try {
        const url = String(args[0] || '');
        if (url.includes('/ws/')) {
          if (!url.includes('/voice/')) captureSocket(ws, 'constructor');
        }
      } catch (e) { /* ignore */ }
      return ws;
    };
    win.WebSocket.prototype = NativeWS.prototype;
    win.WebSocket.CONNECTING = NativeWS.CONNECTING;
    win.WebSocket.OPEN = NativeWS.OPEN;
    win.WebSocket.CLOSING = NativeWS.CLOSING;
    win.WebSocket.CLOSED = NativeWS.CLOSED;
    Object.assign(win.WebSocket, NativeWS);
  };
  wrapConstructor(targetWindow);
  if (targetWindow !== window) wrapConstructor(window);

  const hookPrototypeSend = (win) => {
    const proto = win.WebSocket && win.WebSocket.prototype;
    if (!proto || proto._model3dHooked) return;
    proto._model3dHooked = true;
    const origSend = proto.send;
    proto.send = function (data) {
      if (!capturedWS && this.url && isGameSocket(this)) captureSocket(this, 'prototype.send');
      return origSend.apply(this, arguments);
    };
  };
  hookPrototypeSend(targetWindow);
  if (targetWindow !== window) hookPrototypeSend(window);

  let wasmExports = null;
  let wasmMemory = null;

  const handleWasmResult = (result) => {
    try {
      const inst = (result && result.instance) || result;
      if (inst && inst.exports && inst.exports.set_block && inst.exports.get_block) {
        console.log('[Model3D] Captured WASM engine exports');
        wasmExports = inst.exports;
        wasmMemory = inst.exports.memory;
      }
    } catch (e) { /* ignore */ }
    return result;
  };

  const hookWasm = (win) => {
    if (!win.WebAssembly) return;
    const origInstantiate = win.WebAssembly.instantiate;
    win.WebAssembly.instantiate = async function (...args) {
      return handleWasmResult(await origInstantiate.apply(this, args));
    };
    if (win.WebAssembly.instantiateStreaming) {
      const origStreaming = win.WebAssembly.instantiateStreaming;
      win.WebAssembly.instantiateStreaming = async function (...args) {
        return handleWasmResult(await origStreaming.apply(this, args));
      };
    }
  };
  hookWasm(targetWindow);
  if (targetWindow !== window) hookWasm(window);

  /* ─────────────────────────────────────────────
   * 2. LOW-LEVEL ENGINE & NETWORK DISPATCH
   * ───────────────────────────────────────────── */
  const WORLD_MAX_Y = 128; // Y range is 1..127 (128 is the max build height)

  function sendEditPacket(x, y, z, blockId) {
    const ws = capturedWS;
    if (!ws) {
      console.error('[Model3D] sendEditPacket failed: capturedWS is null (socket not found)');
      return false;
    }
    if (!isGameSocket(ws)) {
      console.error('[Model3D] sendEditPacket failed: captured socket is not the game socket:', ws.url);
      return false;
    }
    if (ws.readyState !== 1) {
      console.error('[Model3D] sendEditPacket failed: ws.readyState is', ws.readyState);
      return false;
    }

    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);

    if (ix < 0 || ix >= 1024 || iz < 0 || iz >= 1024 || iy < 1 || iy >= WORLD_MAX_Y) {
      console.error('[Model3D] sendEditPacket: Out of bounds coordinates:', ix, iy, iz);
      return false;
    }

    const buf = new ArrayBuffer(6);
    const dv = new DataView(buf);
    dv.setUint8(0, 2); // packet type 2: EDIT
    dv.setUint32(1, ((ix << 17) | (iz << 7) | iy) >>> 0, true);
    dv.setUint8(5, blockId);

    try {
      ws.send(buf);
      packetsSentCount++;
      sentEdits.set(editKey(ix, iy, iz), blockId);
      return true;
    } catch (e) {
      console.error('[Model3D] ws.send threw an error:', e);
      return false;
    }
  }

  function placeBlock(x, y, z, blockId) {
    const sent = sendEditPacket(x, y, z, blockId);
    if (!sent) {
      console.error(`[Model3D] ABORT: Could not send packet to server for (${x}, ${y}, ${z})`);
      if (activePrinter && activePrinter.running) {
        activePrinter.stop();
        alert(
          '⚠️ PRINTING STOPPED:\n\n' +
          `Failed to send block edit packet to the server for (${x}, ${y}, ${z}).\n\n` +
          `Socket status: ${capturedWS ? 'readyState ' + capturedWS.readyState : 'NULL'}\n\n` +
          'This safeguards against placing blocks only on your local screen.'
        );
      }
      return false;
    }
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.x) {
      mc.eng.x.set_block(x, y, z, blockId);
      return true;
    }
    if (wasmExports && typeof wasmExports.set_block === 'function') {
      wasmExports.set_block(x, y, z, blockId);
    }
    return true;
  }

  function getBlock(x, y, z) {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.x) return mc.eng.x.get_block(x, y, z);
    if (wasmExports && typeof wasmExports.get_block === 'function') return wasmExports.get_block(x, y, z);
    return -1;
  }

  // True only if the *server* has this exact block. Uses the mirrored server
  // state (sync/relay/deny frames), which is the only reliable source since the
  // local engine is set optimistically and ignores the server's 255 deny marker.
  function serverConfirmed(x, y, z, blockId) {
    const k = editKey(x, y, z);
    if (serverEdits.has(k)) return serverEdits.get(k) === blockId;
    if (sentEdits.has(k)) return false; // we asked; wait for the server to acknowledge
    // Never touched this block -> trust the local engine (e.g. pre-existing terrain).
    return getBlock(x, y, z) === blockId;
  }

  function getPlayerState() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.st) return mc.eng.st;
    if (wasmExports && wasmExports.memory && wasmExports.state_ptr) {
      return new Float64Array(wasmExports.memory.buffer, wasmExports.state_ptr(), 12);
    }
    return null;
  }

  function getPlayerPos() {
    const st = getPlayerState();
    return st ? { x: st[0], y: st[1], z: st[2] } : null;
  }

  function movePlayer(x, y, z) {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.x) {
      try { mc.eng.x.player_fly(1); } catch (e) { /* ignore */ }
      mc.eng.x.player_set(x, y, z);
      const st = mc.eng.st;
      if (st) { st[3] = 0; st[4] = 0; st[5] = 0; }
      return;
    }
    if (wasmExports) {
      if (typeof wasmExports.player_fly === 'function') { try { wasmExports.player_fly(1); } catch (e) { /* ignore */ } }
      if (typeof wasmExports.player_set === 'function') wasmExports.player_set(x, y, z);
      const st = getPlayerState();
      if (st) { st[3] = 0; st[4] = 0; st[5] = 0; }
    }
  }

  /* ─────────────────────────────────────────────
   * 3. BLOCK PALETTE (wool + all solid blocks)
   * ───────────────────────────────────────────── */
  const WOOL_NAMES = [
    'White Wool', 'Orange Wool', 'Magenta Wool', 'Light Blue Wool', 'Yellow Wool', 'Lime Wool',
    'Pink Wool', 'Gray Wool', 'Light Gray Wool', 'Cyan Wool', 'Purple Wool', 'Blue Wool',
    'Brown Wool', 'Green Wool', 'Red Wool', 'Black Wool',
  ];
  const WOOL_RGB = [
    [233, 236, 236], [241, 118, 19], [189, 68, 179], [58, 175, 217],
    [254, 216, 61], [112, 185, 25], [237, 141, 172], [62, 68, 71],
    [142, 142, 134], [21, 137, 145], [121, 42, 172], [53, 57, 157],
    [114, 71, 40], [85, 109, 27], [160, 39, 34], [20, 21, 25],
  ];
  const WOOL_IDS_KNOWN = [47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62];

  const BLOCK_TINT = {
    grass_block_top: [145, 189, 89], short_grass: [145, 189, 89], fern: [145, 189, 89],
    tall_grass_bottom: [145, 189, 89], tall_grass_top: [145, 189, 89],
    large_fern_bottom: [145, 189, 89], large_fern_top: [145, 189, 89],
    spruce_leaves: [97, 153, 97], oak_leaves: [119, 171, 47], birch_leaves: [128, 167, 85],
    water_still: [63, 118, 228], water_flow: [63, 118, 228],
  };
  const TEXCOLOR_KEY = 'tcpixelart.texcolor.v1';
  const EXCLUDED_BLOCKS = new Set(['bedrock']);
  const BLOCK_SUBSTITUTES = { 12: 34 }; // Bedrock → Block of Coal

  let fullPalette = null;
  let fullPalettePromise = null;
  let cachedBlockNames = null;

  function getBlockData() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.blockNames && mc.eng.texNames && mc.eng.ft && mc.eng.kind) {
      return { blockNames: mc.eng.blockNames, texNames: mc.eng.texNames, ft: mc.eng.ft, kind: mc.eng.kind };
    }
    if (
      wasmExports && wasmExports.memory && wasmExports.block_names && wasmExports.tex_names &&
      wasmExports.ft_ptr && wasmExports.kind_ptr
    ) {
      try {
        const mem = wasmExports.memory;
        const b = new Uint8Array(mem.buffer);
        const readC = (ptr) => {
          let q = ptr;
          while (b[q]) q++;
          return new TextDecoder().decode(b.subarray(ptr, q));
        };
        return {
          blockNames: readC(wasmExports.block_names()).split('\n'),
          texNames: readC(wasmExports.tex_names()).split('\n'),
          kind: new Uint8Array(mem.buffer, wasmExports.kind_ptr(), 256).slice(),
          ft: new Uint8Array(mem.buffer, wasmExports.ft_ptr(), 256 * 6).slice(),
        };
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function getBlockName(id) {
    if (!cachedBlockNames) {
      const d = getBlockData();
      if (d && d.blockNames) cachedBlockNames = d.blockNames;
    }
    if (cachedBlockNames) return cachedBlockNames[id] || `#${id}`;
    return `#${id}`;
  }

  function loadTexImage(name) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not load ' + name));
      img.src = `/assets/block/${name}.png`;
    });
  }

  async function averageTextureColor(name, cache) {
    if (cache[name]) return cache[name];
    const img = await loadTexImage(name);
    const c = document.createElement('canvas');
    c.width = 16; c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    const tint = BLOCK_TINT[name];
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 26) continue;
      let pr = d[i], pg = d[i + 1], pb = d[i + 2];
      if (tint) { pr *= tint[0] / 255; pg *= tint[1] / 255; pb *= tint[2] / 255; }
      r += pr; g += pg; b += pb; n++;
    }
    if (!n) return null;
    const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    cache[name] = rgb;
    return rgb;
  }

  function buildFullPalette(onProgress) {
    if (fullPalette) return Promise.resolve(fullPalette);
    if (fullPalettePromise) return fullPalettePromise;

    fullPalettePromise = (async () => {
      const data = getBlockData();
      if (!data) throw new Error('block tables not ready (wait for the world to finish loading)');
      const { blockNames, texNames, ft, kind } = data;
      let cache = {};
      try { cache = JSON.parse(localStorage.getItem(TEXCOLOR_KEY)) || {}; } catch (e) { cache = {}; }

      const entries = [];
      const seenTex = new Set();
      for (let id = 1; id < blockNames.length; id++) {
        if (kind[id] !== 1) continue;
        const bname = blockNames[id] || '';
        if (EXCLUDED_BLOCKS.has(bname.toLowerCase())) continue;
        const isGrass = /grass block/i.test(bname);
        const tex = texNames[ft[id * 6 + (isGrass ? 3 : 0)]];
        if (!tex || seenTex.has(tex)) continue;
        seenTex.add(tex);
        entries.push({ id, name: bname, tex });
      }

      const rgb = [];
      const ids = [];
      let done = 0;
      await Promise.all(entries.map(async (e) => {
        let col = cache[e.tex];
        if (!col) { try { col = await averageTextureColor(e.tex, cache); } catch (err) { col = null; } }
        done++;
        if (onProgress) onProgress(done, entries.length);
        if (col) e.col = col;
      }));

      for (const e of entries) { if (e.col) { rgb.push(e.col); ids.push(e.id); } }
      try { localStorage.setItem(TEXCOLOR_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
      if (rgb.length < 4) throw new Error('could not resolve block colors');
      fullPalette = { rgb, ids, all: true };
      console.log(`[Model3D] All-blocks palette ready: ${rgb.length} colors`);
      return fullPalette;
    })();

    fullPalettePromise.catch(() => { fullPalettePromise = null; });
    return fullPalettePromise;
  }

  function sanitizePalette(pal) {
    if (!pal || !pal.ids) return pal;
    let changed = false;
    const ids = pal.ids.map((id) => {
      if (BLOCK_SUBSTITUTES[id] != null) { changed = true; return BLOCK_SUBSTITUTES[id]; }
      return id;
    });
    return changed ? { rgb: pal.rgb, ids, all: pal.all } : pal;
  }

  // Curated quick-pick blocks for single-color mode.
  const SINGLE_BLOCKS = [
    [47, 'White Wool'], [48, 'Orange Wool'], [49, 'Magenta Wool'], [50, 'Light Blue Wool'],
    [51, 'Yellow Wool'], [52, 'Lime Wool'], [53, 'Pink Wool'], [54, 'Gray Wool'],
    [55, 'Light Gray Wool'], [56, 'Cyan Wool'], [57, 'Purple Wool'], [58, 'Blue Wool'],
    [59, 'Brown Wool'], [60, 'Green Wool'], [61, 'Red Wool'], [62, 'Black Wool'],
    [1, 'Stone'], [4, 'Cobblestone'], [5, 'Oak Planks'], [8, 'Sand'], [11, 'Bricks'],
    [21, 'Stone Bricks'], [23, 'Smooth Stone'], [24, 'Obsidian'], [34, 'Block of Coal'],
    [35, 'Block of Iron'], [36, 'Block of Gold'], [37, 'Block of Diamond'],
    [38, 'Block of Emerald'], [39, 'Block of Lapis'], [40, 'Block of Spark'],
    [42, 'Block of Quartz'], [43, 'Clay'], [41, 'Lumen Rock'],
  ];

  function nearestPaletteIndex(r, g, b, pal) {
    let bestDist = Infinity, bestIdx = 0;
    for (let i = 0; i < pal.rgb.length; i++) {
      const [wr, wg, wb] = pal.rgb[i];
      const dr = r - wr, dg = g - wg, db = b - wb;
      const rMean = (r + wr) / 2;
      const dist = (2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return bestIdx;
  }

  /* ─────────────────────────────────────────────
   * 4. 3D MODEL PARSERS (OBJ+MTL / STL / GLB)
   * ─────────────────────────────────────────────
   * Each parser returns an array of triangles:
   *   { a:[x,y,z], b:[x,y,z], c:[x,y,z], color:[r,g,b]|null }  (color 0..255)
   */

  function parseOBJ(text, mtlMap) {
    const verts = [];
    const vcolors = [];
    const tris = [];
    const positions = [];
    const curColor = [];
    let curMat = null;
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const tag = parts[0];
      if (tag === 'v') {
        positions.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
        // Optional per-vertex color (some exporters)
        if (parts.length >= 7) {
          let r = parseFloat(parts[4]), g = parseFloat(parts[5]), b = parseFloat(parts[6]);
          if (r <= 1 && g <= 1 && b <= 1) { r *= 255; g *= 255; b *= 255; }
          curColor.push([r, g, b]);
        } else {
          curColor.push(null);
        }
      } else if (tag === 'usemtl') {
        curMat = mtlMap ? mtlMap.get(parts.slice(1).join(' ')) || null : null;
      } else if (tag === 'f') {
        const idxs = [];
        for (let i = 1; i < parts.length; i++) {
          const token = parts[i].split('/')[0];
          let vi = parseInt(token, 10);
          if (isNaN(vi)) continue;
          if (vi < 0) vi = positions.length + vi; else vi -= 1;
          idxs.push(vi);
        }
        for (let i = 1; i + 1 < idxs.length; i++) {
          const i0 = idxs[0], i1 = idxs[i], i2 = idxs[i + 1];
          const p0 = positions[i0], p1 = positions[i1], p2 = positions[i2];
          if (!p0 || !p1 || !p2) continue;
          let col = curMat;
          if (!col) {
            const c0 = curColor[i0], c1 = curColor[i1], c2 = curColor[i2];
            if (c0 && c1 && c2) col = [(c0[0] + c1[0] + c2[0]) / 3, (c0[1] + c1[1] + c2[1]) / 3, (c0[2] + c1[2] + c2[2]) / 3];
            else if (c0) col = c0;
          }
          tris.push({ a: p0, b: p1, c: p2, color: col });
        }
      }
    }
    return tris;
  }

  function parseMTL(text) {
    const map = new Map();
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      if (parts[0] === 'newmtl') {
        cur = parts.slice(1).join(' ');
        map.set(cur, null);
      } else if (parts[0] === 'Kd' && cur) {
        const r = parseFloat(parts[1]) || 0, g = parseFloat(parts[2]) || 0, b = parseFloat(parts[3]) || 0;
        map.set(cur, [Math.min(255, r * 255), Math.min(255, g * 255), Math.min(255, b * 255)]);
      }
    }
    return map;
  }

  function parseSTL(buffer) {
    const tris = [];
    const head = new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength)));
    const isAscii = head.trim().startsWith('solid') && head.includes('facet');
    if (isAscii) {
      const text = new TextDecoder().decode(buffer);
      const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
      const verts = [];
      let m;
      while ((m = re.exec(text))) verts.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
      for (let i = 0; i + 2 < verts.length; i += 3) {
        tris.push({ a: verts[i], b: verts[i + 1], c: verts[i + 2], color: null });
      }
      return tris;
    }
    // Binary STL
    const dv = new DataView(buffer);
    const count = dv.getUint32(80, true);
    let off = 84;
    for (let i = 0; i < count && off + 50 <= buffer.byteLength; i++) {
      const a = [dv.getFloat32(off + 12, true), dv.getFloat32(off + 16, true), dv.getFloat32(off + 20, true)];
      const b = [dv.getFloat32(off + 24, true), dv.getFloat32(off + 28, true), dv.getFloat32(off + 32, true)];
      const c = [dv.getFloat32(off + 36, true), dv.getFloat32(off + 40, true), dv.getFloat32(off + 44, true)];
      tris.push({ a, b, c, color: null });
      off += 50;
    }
    return tris;
  }

  function glbAccessorReader(json, bin, accIndex) {
    const acc = json.accessors[accIndex];
    const bv = json.bufferViews[acc.bufferView];
    const compSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    const numComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
    const baseOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || compSize * numComp;
    const read = (i, c) => {
      const o = baseOffset + i * stride + c * compSize;
      switch (acc.componentType) {
        case 5126: return bin.getFloat32(o, true);
        case 5125: return bin.getUint32(o, true);
        case 5123: return bin.getUint16(o, true);
        case 5121: return bin.getUint8(o);
        case 5122: return bin.getInt16(o, true);
        case 5120: return bin.getInt8(o);
        default: return 0;
      }
    };
    return { count: acc.count, numComp, read };
  }

  function parseGLB(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    const magic = dv.getUint32(0, true);
    if (magic !== 0x46546C67) throw new Error('not a GLB file');
    let off = 12;
    let json = null, bin = null;
    while (off + 8 <= arrayBuffer.byteLength) {
      const len = dv.getUint32(off, true);
      const type = dv.getUint32(off + 4, true);
      const dataStart = off + 8;
      if (type === 0x4E4F534A) {
        json = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, dataStart, len)));
      } else if (type === 0x004E4942) {
        bin = new DataView(arrayBuffer, dataStart, len);
      }
      off = dataStart + len;
      if (json && bin) break;
    }
    if (!json || !bin) throw new Error('GLB missing JSON or BIN chunk');

    const tris = [];
    const srgb = (x) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

    const nodeWorld = (json.nodes || []).map(() => null);
    const mul = (a, b) => {
      // column-major 4x4
      const o = new Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
      return o;
    };
    const trsMatrix = (node) => {
      if (node.matrix) return node.matrix.slice();
      const t = node.translation || [0, 0, 0];
      const r = node.rotation || [0, 0, 0, 1];
      const s = node.scale || [1, 1, 1];
      const [x, y, z, w] = r;
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      const m = [
        (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
        (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
        (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
        t[0], t[1], t[2], 1,
      ];
      return m;
    };
    const xform = (m, p) => [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
    ];

    const meshTris = (mesh, world, color) => {
      for (const prim of mesh.primitives || []) {
        if (prim.mode != null && prim.mode !== 4) continue; // triangles only
        const pos = glbAccessorReader(json, bin, prim.attributes.POSITION);
        const localColor = color;
        const indexAcc = prim.indices != null ? glbAccessorReader(json, bin, prim.indices) : null;
        const getIdx = indexAcc ? (i) => indexAcc.read(i, 0) : (i) => i;
        const n = indexAcc ? indexAcc.count : pos.count;
        for (let i = 0; i + 2 < n; i += 3) {
          const i0 = getIdx(i), i1 = getIdx(i + 1), i2 = getIdx(i + 2);
          const p0 = xform(world, [pos.read(i0, 0), pos.read(i0, 1), pos.read(i0, 2)]);
          const p1 = xform(world, [pos.read(i1, 0), pos.read(i1, 1), pos.read(i1, 2)]);
          const p2 = xform(world, [pos.read(i2, 0), pos.read(i2, 1), pos.read(i2, 2)]);
          tris.push({ a: p0, b: p1, c: p2, color: localColor });
        }
      }
    };

    const visit = (nodeIndex, parentMatrix) => {
      const node = json.nodes[nodeIndex];
      const world = mul(parentMatrix, trsMatrix(node));
      if (node.mesh != null) {
        const mesh = json.meshes[node.mesh];
        for (const prim of mesh.primitives || []) {
          let color = null;
          if (prim.material != null && json.materials && json.materials[prim.material]) {
            const bc = json.materials[prim.material].pbrMetallicRoughness;
            if (bc && bc.baseColorFactor) {
              const f = bc.baseColorFactor;
              color = [srgb(f[0]) * 255, srgb(f[1]) * 255, srgb(f[2]) * 255];
            }
          }
          meshTris({ primitives: [prim] }, world, color);
        }
      }
      for (const child of node.children || []) visit(child, world);
    };

    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = json.scenes && json.scenes[json.scene || 0];
    const roots = (scene && scene.nodes) || json.nodes.map((_, i) => i);
    for (const r of roots) visit(r, identity);
    return tris;
  }

  /* ── FBX (via three.js FBXLoader, loaded lazily from a CDN) ── */
  const THREE_CDN = 'https://unpkg.com/three@0.137.0';
  const _loadedScripts = new Map();
  let _fbxReady = null;

  function loadExternalScript(url) {
    if (_loadedScripts.has(url)) return _loadedScripts.get(url);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = url;
      s.async = false;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + url));
      (document.head || document.documentElement).appendChild(s);
    });
    _loadedScripts.set(url, p);
    return p;
  }

  function ensureFBXLoader() {
    const existing = targetWindow.THREE || (typeof THREE !== 'undefined' ? THREE : null);
    if (existing && existing.FBXLoader) return Promise.resolve(existing);
    if (_fbxReady) return _fbxReady;

    _fbxReady = (async () => {
      await loadExternalScript(`${THREE_CDN}/build/three.min.js`);
      await loadExternalScript(`${THREE_CDN}/examples/js/libs/fflate.min.js`);
      await loadExternalScript(`${THREE_CDN}/examples/js/loaders/FBXLoader.js`);
      const T = targetWindow.THREE || (typeof THREE !== 'undefined' ? THREE : null);
      if (!T || !T.FBXLoader) throw new Error('FBXLoader did not initialize');
      return T;
    })();
    _fbxReady.catch(() => { _fbxReady = null; });
    return _fbxReady;
  }

  function parseFBX(THREE, arrayBuffer) {
    const root = new THREE.FBXLoader().parse(arrayBuffer, '');
    root.updateMatrixWorld(true);
    const tris = [];
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const geom = obj.geometry;
      if (!geom || !geom.attributes || !geom.attributes.position) return;
      const posAttr = geom.attributes.position;
      const index = geom.index;
      const matArr = Array.isArray(obj.material) ? obj.material : [obj.material];
      const hasVColors = !!geom.attributes.color;
      const colorAttr = geom.attributes.color;
      const idxAt = (k) => (index ? index.getX(k) : k);
      const vert = (i) => {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
        return [v.x, v.y, v.z];
      };
      const matColor = (m) => (m && m.color
        ? [Math.round(m.color.r * 255), Math.round(m.color.g * 255), Math.round(m.color.b * 255)]
        : null);
      const vColor = (i0, i1, i2) => {
        const c = colorAttr;
        return [
          ((c.getX(i0) + c.getX(i1) + c.getX(i2)) / 3) * 255,
          ((c.getY(i0) + c.getY(i1) + c.getY(i2)) / 3) * 255,
          ((c.getZ(i0) + c.getZ(i1) + c.getZ(i2)) / 3) * 255,
        ];
      };
      const pushTri = (i0, i1, i2, color) => {
        tris.push({ a: vert(i0), b: vert(i1), c: vert(i2), color: color || null });
      };

      const useGroups = matArr.length > 1 && geom.groups && geom.groups.length;
      if (useGroups) {
        for (const g of geom.groups) {
          const col = matColor(matArr[g.materialIndex]);
          const tStart = Math.floor(g.start / 3);
          const tEnd = Math.floor((g.start + g.count) / 3);
          for (let t = tStart; t < tEnd; t++) {
            const i0 = idxAt(t * 3), i1 = idxAt(t * 3 + 1), i2 = idxAt(t * 3 + 2);
            pushTri(i0, i1, i2, col || (hasVColors ? vColor(i0, i1, i2) : null));
          }
        }
      } else {
        const col = matColor(matArr[0]);
        const triCount = Math.floor((index ? index.count : posAttr.count) / 3);
        for (let t = 0; t < triCount; t++) {
          const i0 = idxAt(t * 3), i1 = idxAt(t * 3 + 1), i2 = idxAt(t * 3 + 2);
          pushTri(i0, i1, i2, col || (hasVColors ? vColor(i0, i1, i2) : null));
        }
      }
    });
    return tris;
  }

  /* ─────────────────────────────────────────────
   * 5. VOXELIZATION
   * ───────────────────────────────────────────── */
  // triangles -> { voxels: Map(key -> [r,g,b]|null), dx, dy, dz, count, surfaceCount }
  function voxelize(triangles, maxSize, upAxis, fillSolid) {
    if (!triangles.length) throw new Error('model has no triangles');

    // Optionally swap Y/Z so Z-up models stand upright.
    const tp = (p) => (upAxis === 'z' ? [p[0], p[2], p[1]] : [p[0], p[1], p[2]]);

    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const t of triangles) {
      for (const v of [t.a, t.b, t.c]) {
        const p = tp(v);
        for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
      }
    }
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const longest = Math.max(size[0], size[1], size[2]) || 1;
    let scale = maxSize / longest;

    // Enforce the 128-block build height on the vertical (Y) axis.
    if (size[1] > 0 && size[1] * scale > WORLD_MAX_Y - 1) scale = (WORLD_MAX_Y - 1) / size[1];

    const dims = [
      Math.max(1, Math.ceil(size[0] * scale)),
      Math.max(1, Math.ceil(size[1] * scale)),
      Math.max(1, Math.ceil(size[2] * scale)),
    ];

    const toVoxel = (p) => {
      const q = tp(p);
      return [
        (q[0] - min[0]) * scale,
        (q[1] - min[1]) * scale,
        (q[2] - min[2]) * scale,
      ];
    };

    const map = new Map();
    const keyOf = (x, y, z) => (x * 4096 + y) * 4096 + z;

    const mark = (x, y, z, color) => {
      // Clamp the far boundary (coordinate == max maps to index dims) into the last voxel
      // so the shell stays closed on the positive faces.
      const cx = x < 0 ? 0 : (x >= dims[0] ? dims[0] - 1 : x);
      const cy = y < 0 ? 0 : (y >= dims[1] ? dims[1] - 1 : y);
      const cz = z < 0 ? 0 : (z >= dims[2] ? dims[2] - 1 : z);
      const k = keyOf(cx, cy, cz);
      if (!map.has(k)) map.set(k, color || null);
    };

    // Surface rasterization: subdivide each triangle and mark the voxel of each sample.
    for (const t of triangles) {
      const a = toVoxel(t.a), b = toVoxel(t.b), c = toVoxel(t.c);
      const e = Math.max(
        Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]),
        Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]),
        Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2])
      );
      const n = Math.max(1, Math.ceil(e / 0.5));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const u = i / n, v = j / n;
          const x = a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v;
          const y = a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v;
          const z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v;
          mark(Math.floor(x), Math.floor(y), Math.floor(z), t.color);
        }
      }
    }

    const surfaceCount = map.size;

    // Optional solid fill using even-odd scanlines along Z.
    if (fillSolid) {
      for (let x = 0; x < dims[0]; x++) {
        for (let y = 0; y < dims[1]; y++) {
          const zs = [];
          for (let z = 0; z < dims[2]; z++) if (map.has(keyOf(x, y, z))) zs.push(z);
          for (let i = 0; i + 1 < zs.length; i += 2) {
            for (let z = zs[i] + 1; z < zs[i + 1]; z++) {
              const k = keyOf(x, y, z);
              if (!map.has(k)) map.set(k, map.get(keyOf(x, y, zs[i])));
            }
          }
        }
      }
    }

    return { voxels: map, dx: dims[0], dy: dims[1], dz: dims[2], count: map.size, surfaceCount };
  }

  /* ─────────────────────────────────────────────
   * 6. MODEL PRINTER BOT
   * ───────────────────────────────────────────── */
  class ModelPrinter {
    constructor() {
      this.running = false;
      this.paused = false;
      this.delayMs = 50;
      this.retries = 12;
      this.movePlayer = true;
      this.standoff = 3;
      this.progress = { placed: 0, total: 0, layer: 0, layers: 0, status: '' };
      this.onProgress = null;
      this._cancel = false;
    }

    _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
    async _waitUnpaused() { while (this.paused && !this._cancel) await this._sleep(100); }
    _notify() { if (this.onProgress) this.onProgress({ ...this.progress }); }

    stop() {
      this._cancel = true;
      this.running = false;
      this.paused = false;
      this.progress.status = '⛔ Stopped';
      this._notify();
    }

    togglePause() {
      this.paused = !this.paused;
      this.progress.status = this.paused ? '⏸ Paused' : 'Building…';
      this._notify();
    }

    // items: array of { x, y, z, blockId } in local grid coords (y = layer, 0-based)
    async build(items, origin, delayMs, retries, movePlayer) {
      this.delayMs = delayMs;
      this.retries = retries;
      this.movePlayer = movePlayer;
      this.running = true;
      this.paused = false;
      this._cancel = false;

      // Group by layer (y) ascending; within a layer sort by z then x.
      const byLayer = new Map();
      for (const it of items) {
        if (!byLayer.has(it.y)) byLayer.set(it.y, []);
        byLayer.get(it.y).push(it);
      }
      const layers = [...byLayer.keys()].sort((a, b) => a - b);

      this.progress = { placed: 0, total: items.length, layer: 0, layers: layers.length, status: 'Starting build…' };
      this._notify();

      for (let li = 0; li < layers.length && !this._cancel; li++) {
        const layerY = layers[li];
        const row = byLayer.get(layerY).sort((a, b) => (a.z - b.z) || (a.x - b.x));
        this.progress.layer = li + 1;

        for (const it of row) {
          await this._waitUnpaused();
          if (this._cancel) return;
          const wx = origin.x + it.x;
          const wy = origin.y + it.y;
          const wz = origin.z + it.z;
          if (this.movePlayer) movePlayer_(wx + 0.5, wy + this.standoff, wz + 0.5);
          if (!placeBlock(wx, wy, wz, it.blockId)) return;
          this.progress.placed++;
          this.progress.status = `Layer ${li + 1}/${layers.length} · placed ${this.progress.placed}/${this.progress.total}`;
          this._notify();
          await this._sleep(this.delayMs);
        }

        // Verification & retry for this layer.
        // The server acknowledges accepted edits (echoed back) and rejects
        // rate-limited ones with a deny frame; serverConfirmed() reads that
        // authoritative mirrored state instead of the optimistic local world.
        for (let pass = 1; pass <= this.retries && !this._cancel; pass++) {
          await this._sleep(pass === 1 ? 300 : 250);
          const missing = [];
          for (const it of row) {
            const wx = origin.x + it.x, wy = origin.y + it.y, wz = origin.z + it.z;
            if (!serverConfirmed(wx, wy, wz, it.blockId)) missing.push(it);
          }
          if (!missing.length) break;
          this.progress.status = `Layer ${li + 1}: fixing ${missing.length} missed blocks (pass ${pass})…`;
          this._notify();
          const retryDelay = this.delayMs + (pass - 1) * 15;
          for (const it of missing) {
            await this._waitUnpaused();
            if (this._cancel) return;
            const wx = origin.x + it.x, wy = origin.y + it.y, wz = origin.z + it.z;
            if (this.movePlayer) movePlayer_(wx + 0.5, wy + this.standoff, wz + 0.5);
            placeBlock(wx, wy, wz, it.blockId);
            await this._sleep(retryDelay);
          }
        }
        await this._sleep(60);
      }

      this.running = false;
      let stillMissing = 0;
      if (!this._cancel) {
        for (const it of items) {
          if (!serverConfirmed(origin.x + it.x, origin.y + it.y, origin.z + it.z, it.blockId)) stillMissing++;
        }
      }
      this.progress.status = this._cancel
        ? '⛔ Stopped'
        : (stillMissing
          ? `⚠️ Finished with ${stillMissing} unconfirmed block(s) — raise Delay or Retries and run again`
          : '✅ Build complete!');
      if (stillMissing) console.warn(`[Model3D] ${stillMissing} block(s) were not confirmed by the server.`);
      this._notify();
    }

    // Clear a bounding box (fill air) around origin..origin+dims
    async clearBox(origin, dx, dy, dz, delayMs, followPlayer) {
      this.delayMs = delayMs;
      this.movePlayer = followPlayer;
      this.running = true;
      this._cancel = false;
      this.paused = false;
      const total = dx * dy * dz;
      this.progress = { placed: 0, total, layer: 0, layers: dy, status: 'Clearing…' };
      this._notify();
      for (let y = 0; y < dy && !this._cancel; y++) {
        for (let z = 0; z < dz && !this._cancel; z++) {
          for (let x = 0; x < dx && !this._cancel; x++) {
            const wx = origin.x + x, wy = origin.y + y, wz = origin.z + z;
            if (getBlock(wx, wy, wz) === 0) { this.progress.placed++; continue; }
            if (this.movePlayer) movePlayer_(wx + 0.5, wy + this.standoff, wz + 0.5);
            if (!placeBlock(wx, wy, wz, 0)) return;
            this.progress.placed++;
            await this._sleep(this.delayMs);
          }
        }
        this.progress.status = `Clearing layer ${y + 1}/${dy}…`;
        this._notify();
      }
      this.running = false;
      this.progress.status = this._cancel ? '⛔ Stopped' : '✅ Cleared!';
      this._notify();
    }
  }
  // local alias so class methods can call the module-level movePlayer
  const movePlayer_ = movePlayer;

  /* ─────────────────────────────────────────────
   * 7. UI
   * ───────────────────────────────────────────── */
  let currentVoxels = null; // { voxels, dx, dy, dz, count, surfaceCount }
  let currentName = '';

  function updateStatusUI() {
    const dot = document.getElementById('m3d-conn-dot');
    const txt = document.getElementById('m3d-conn-text');
    const badge = document.getElementById('m3d-lock-badge');
    const startBtn = document.getElementById('m3d-start-btn');
    if (!dot || !txt) return;

    if (capturedWS && capturedWS.readyState === 1) {
      dot.style.background = '#22c55e';
      txt.innerHTML = `Live Connected (${packetsSentCount} packets sent)`;
      if (startBtn && activePrinter && !activePrinter.running && currentVoxels) startBtn.disabled = false;
    } else {
      dot.style.background = '#ef4444';
      txt.textContent = 'Waiting for game WebSocket…';
      if (startBtn && (!activePrinter || !activePrinter.running)) startBtn.disabled = true;
    }

    if (badge) {
      badge.style.display = 'inline-block';
      if (roomInfo.lock === 1) {
        if (playerInfo.verified) {
          badge.style.background = 'rgba(34,197,94,0.2)'; badge.style.color = '#86efac';
          badge.textContent = `Verified (@${playerInfo.handle || playerInfo.name})`;
        } else {
          badge.style.background = 'rgba(239,68,68,0.25)'; badge.style.color = '#fca5a5';
          badge.textContent = 'Locked: Verified Only (Press V)';
        }
      } else if (roomInfo.lock === 2) {
        badge.style.background = 'rgba(239,68,68,0.25)'; badge.style.color = '#fca5a5';
        badge.textContent = 'Locked: Owner Only';
      } else {
        badge.style.background = 'rgba(59,130,246,0.2)'; badge.style.color = '#93c5fd';
        badge.textContent = 'Build: Anyone (Open World)';
      }
    }
  }

  function renderIsoPreview(canvas, vx, colorFn) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, W, H);

    const list = [];
    for (const [k, col] of vx.voxels) {
      const z = k % 4096;
      const y = Math.floor(k / 4096) % 4096;
      const x = Math.floor(k / (4096 * 4096));
      list.push([x, y, z, col]);
    }
    if (!list.length) return;
    list.sort((p, q) => (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2])); // far → near

    const spanX = vx.dx + vx.dz;
    const spanY = (vx.dx + vx.dz) * 0.5 + vx.dy;
    const s = Math.max(1, Math.min((W - 24) / spanX, (H - 24) / spanY));
    const cx = W / 2 - ((vx.dx - vx.dz) / 2) * s;
    const topY = vx.dy * s;
    const cy = (H - spanY * s) / 2 + topY;

    const maxDraw = 60000;
    const step = Math.max(1, Math.ceil(list.length / maxDraw));
    for (let i = 0; i < list.length; i += step) {
      const [x, y, z, col] = list[i];
      const ix = (x - z) * s;
      const iy = (x + z) * 0.5 * s - y * s;
      const px = cx + ix;
      const py = cy + iy;
      const c = colorFn(col);
      ctx.fillStyle = c;
      ctx.fillRect(px, py, s, s);
      if (s >= 3) {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(px, py, s, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(px, py + s - 1, s, 1);
      }
    }
  }

  function createUI(printer) {
    activePrinter = printer;
    const existing = document.getElementById('m3d-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'm3d-panel';
    panel.innerHTML = `
      <style>
        #m3d-panel {
          position: fixed; top: 16px; right: 380px; width: 360px;
          background: rgba(13,14,22,0.94); backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255,255,255,0.10); border-radius: 16px;
          color: #f0f0f5;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px; z-index: 999999;
          box-shadow: 0 16px 40px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.05) inset;
          overflow: hidden; user-select: none;
        }
        #m3d-panel * { box-sizing: border-box; }
        #m3d-header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 12px 16px;
          background: linear-gradient(135deg, rgba(20,184,166,0.25), rgba(59,130,246,0.15));
          cursor: grab; border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        #m3d-header:active { cursor: grabbing; }
        #m3d-header .title { font-weight: 700; font-size: 14px; display: flex; align-items: center; gap: 8px; letter-spacing: 0.2px; }
        #m3d-header .byline { margin-top: 2px; font-size: 10px; font-weight: 500; color: #5eead4; opacity: 0.9; letter-spacing: 0.3px; }
        #m3d-conn-status {
          display: flex; align-items: center; gap: 6px; font-size: 11px;
          color: rgba(255,255,255,0.7); padding: 6px 16px;
          background: rgba(0,0,0,0.25); border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        #m3d-conn-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; transition: background 0.3s; }
        #m3d-lock-badge { margin-left: auto; font-size: 10px; padding: 2px 7px; border-radius: 6px; font-weight: 600; }
        #m3d-toggle-btn {
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
          color: #bbb; border-radius: 6px; padding: 3px 8px; cursor: pointer; font-size: 12px;
        }
        #m3d-toggle-btn:hover { background: rgba(255,255,255,0.16); color: #fff; }
        #m3d-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; max-height: 82vh; overflow-y: auto; }
        #m3d-body.collapsed { display: none; }
        .m3d-section { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 12px; padding: 12px; }
        .m3d-section h3 {
          margin: 0 0 10px 0; font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.8px; color: rgba(255,255,255,0.5); display: flex; justify-content: space-between; align-items: center;
        }
        #m3d-dropzone {
          border: 2px dashed rgba(20,184,166,0.45); border-radius: 10px; padding: 20px 14px; text-align: center;
          color: rgba(255,255,255,0.5); transition: all 0.2s; cursor: pointer;
        }
        #m3d-dropzone:hover, #m3d-dropzone.dragover { border-color: rgba(20,184,166,0.9); background: rgba(20,184,166,0.08); color: #fff; }
        #m3d-dropzone input { display: none; }
        #m3d-dropzone .icon { font-size: 28px; margin-bottom: 6px; }
        #m3d-preview-wrap { display: none; flex-direction: column; align-items: center; gap: 8px; }
        #m3d-preview-wrap.visible { display: flex; }
        #m3d-preview { border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
        #m3d-preview-info { font-size: 11px; color: rgba(255,255,255,0.55); text-align: center; line-height: 1.4; }
        .m3d-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
        .m3d-row:last-child { margin-bottom: 0; }
        .m3d-row label { font-size: 12px; color: rgba(255,255,255,0.65); min-width: 92px; }
        .m3d-row input[type="number"], .m3d-row select {
          flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px; color: #fff; padding: 6px 8px; font-size: 12px; outline: none;
        }
        .m3d-row input:focus, .m3d-row select:focus { border-color: rgba(20,184,166,0.6); }
        .m3d-row input[type="checkbox"] { accent-color: #14b8a6; width: 16px; height: 16px; cursor: pointer; }
        .m3d-row .hint { font-size: 11px; color: rgba(255,255,255,0.45); margin-left: 6px; }
        .m3d-coord-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 8px; }
        .m3d-coord-row label { font-size: 11px; color: rgba(255,255,255,0.45); text-align: center; display: block; margin-bottom: 3px; }
        .m3d-coord-row input {
          width: 100%; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px; color: #fff; padding: 6px; font-size: 12px; text-align: center;
          font-family: monospace; outline: none;
        }
        .m3d-btn-secondary {
          background: rgba(59,130,246,0.15); border: 1px solid rgba(59,130,246,0.3); color: #93c5fd;
          border-radius: 6px; padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 500; width: 100%;
        }
        .m3d-btn-secondary:hover { background: rgba(59,130,246,0.28); color: #bfdbfe; }
        #m3d-controls { display: flex; gap: 8px; }
        .m3d-btn { flex: 1; padding: 10px; border-radius: 8px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; }
        #m3d-start-btn { background: linear-gradient(135deg, #14b8a6, #3b82f6); color: #fff; box-shadow: 0 4px 14px rgba(20,184,166,0.35); }
        #m3d-start-btn:hover { filter: brightness(1.15); }
        #m3d-start-btn:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; filter: none; }
        #m3d-pause-btn { background: rgba(234,179,8,0.15); color: #facc15; border: 1px solid rgba(234,179,8,0.3); }
        #m3d-pause-btn:hover { background: rgba(234,179,8,0.25); }
        #m3d-stop-btn { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
        #m3d-stop-btn:hover { background: rgba(239,68,68,0.25); }
        #m3d-clear-btn {
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); color: #bbb;
          border-radius: 6px; padding: 7px; font-size: 11px; cursor: pointer; width: 100%; margin-top: 6px;
        }
        #m3d-clear-btn:hover { background: rgba(239,68,68,0.2); color: #f87171; border-color: rgba(239,68,68,0.4); }
        #m3d-progress-section { display: none; }
        #m3d-progress-section.visible { display: block; }
        #m3d-progress-bar-outer { width: 100%; height: 8px; background: rgba(255,255,255,0.08); border-radius: 4px; overflow: hidden; margin-bottom: 8px; }
        #m3d-progress-bar { height: 100%; width: 0%; background: linear-gradient(90deg, #14b8a6, #3b82f6); border-radius: 4px; transition: width 0.2s ease; }
        #m3d-status { font-size: 11px; color: rgba(255,255,255,0.65); line-height: 1.4; }
      </style>

      <div id="m3d-header">
        <div>
          <div class="title"><span>🧊</span> 3D Model Printer <span style="font-size:10px; color:#5eead4; background:rgba(20,184,166,0.25); padding:2px 6px; border-radius:10px;">v1.2.0</span></div>
          <div class="byline">by @vibecodingonsol</div>
        </div>
        <button id="m3d-toggle-btn">▾</button>
      </div>

      <div id="m3d-conn-status">
        <div id="m3d-conn-dot"></div>
        <span id="m3d-conn-text">Waiting for game WebSocket…</span>
        <span id="m3d-lock-badge" style="display:none;"></span>
      </div>

      <div id="m3d-body">
        <div class="m3d-section">
          <h3><span>📦 Model</span> <span style="font-weight:normal; font-size:10px; color:#5eead4;">OBJ (MTL) · STL · GLB · FBX</span></h3>
          <div id="m3d-dropzone">
            <div class="icon">🧊</div>
            <div>Drop a 3D model here or <strong>browse</strong></div>
            <div style="font-size:10px; margin-top:4px; opacity:0.7;">OBJ: select the .obj and its .mtl together for colors</div>
            <input type="file" id="m3d-file" accept=".obj,.mtl,.stl,.glb,.gltf,.fbx" multiple>
          </div>
          <div id="m3d-preview-wrap">
            <canvas id="m3d-preview" width="320" height="240"></canvas>
            <div id="m3d-preview-info"></div>
          </div>
        </div>

        <div class="m3d-section">
          <h3>⚙️ Build Settings</h3>
          <div class="m3d-row">
            <label>Max Size</label>
            <input type="number" id="m3d-size" value="48" min="4" max="128" step="1">
            <span class="hint">blocks on longest axis (≤128 high)</span>
          </div>
          <div class="m3d-row">
            <label>Up Axis</label>
            <select id="m3d-up">
              <option value="y">Y-up (OBJ / GLB)</option>
              <option value="z">Z-up (STL / 3D-print)</option>
            </select>
          </div>
          <div class="m3d-row">
            <label>Fill</label>
            <input type="checkbox" id="m3d-solid" title="Fill the interior solid instead of only the surface shell">
            <span class="hint">Solid (more blocks)</span>
          </div>
          <div class="m3d-row">
            <label>Colors</label>
            <select id="m3d-colormode">
              <option value="model">From model (all blocks)</option>
              <option value="single">Single block</option>
            </select>
          </div>
          <div class="m3d-row">
            <label>Block</label>
            <select id="m3d-single"></select>
          </div>
          <div class="m3d-row">
            <label>Delay (ms)</label>
            <input type="number" id="m3d-delay" value="50" min="10" max="2000" step="5">
          </div>
          <div class="m3d-row">
            <label>Layer Retries</label>
            <input type="number" id="m3d-retries" value="12" min="1" max="60" step="1">
          </div>
          <div class="m3d-row">
            <label>Move Player</label>
            <input type="checkbox" id="m3d-move" checked>
            <span class="hint">Fly along with the build</span>
          </div>
        </div>

        <div class="m3d-section">
          <h3>📍 Origin (model corner)</h3>
          <div class="m3d-coord-row">
            <div><label>X</label><input type="number" id="m3d-ox" value="0"></div>
            <div><label>Y</label><input type="number" id="m3d-oy" value="64"></div>
            <div><label>Z</label><input type="number" id="m3d-oz" value="0"></div>
          </div>
          <button id="m3d-get-pos" class="m3d-btn-secondary">📌 Use My Current Position</button>
        </div>

        <div id="m3d-controls">
          <button id="m3d-start-btn" class="m3d-btn" disabled>▶ Build Model</button>
          <button id="m3d-pause-btn" class="m3d-btn" style="display:none;">⏸ Pause</button>
          <button id="m3d-stop-btn" class="m3d-btn" style="display:none;">⏹ Stop</button>
        </div>

        <button id="m3d-clear-btn">🧹 Clear Model Bounding Box (Fill with Air)</button>

        <div id="m3d-progress-section" class="m3d-section">
          <h3>📊 Progress</h3>
          <div id="m3d-progress-bar-outer"><div id="m3d-progress-bar"></div></div>
          <div id="m3d-status"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Drag
    const header = panel.querySelector('#m3d-header');
    let dragOff = { x: 0, y: 0 };
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'm3d-toggle-btn') return;
      e.preventDefault();
      dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
      const onMove = (ev) => {
        panel.style.left = Math.max(0, ev.clientX - dragOff.x) + 'px';
        panel.style.top = Math.max(0, ev.clientY - dragOff.y) + 'px';
      };
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    panel.querySelector('#m3d-toggle-btn').addEventListener('click', () => {
      const b = panel.querySelector('#m3d-body');
      b.classList.toggle('collapsed');
      panel.querySelector('#m3d-toggle-btn').textContent = b.classList.contains('collapsed') ? '▸' : '▾';
    });

    // Single-block picker
    const singleSel = panel.querySelector('#m3d-single');
    for (const [id, name] of SINGLE_BLOCKS) {
      const o = document.createElement('option');
      o.value = String(id); o.textContent = name;
      singleSel.appendChild(o);
    }

    const dropzone = panel.querySelector('#m3d-dropzone');
    const fileInput = panel.querySelector('#m3d-file');
    const previewWrap = panel.querySelector('#m3d-preview-wrap');
    const previewCanvas = panel.querySelector('#m3d-preview');
    const previewInfo = panel.querySelector('#m3d-preview-info');
    const startBtn = panel.querySelector('#m3d-start-btn');
    const sizeInput = panel.querySelector('#m3d-size');
    const upSel = panel.querySelector('#m3d-up');
    const solidCheck = panel.querySelector('#m3d-solid');
    const colorModeSel = panel.querySelector('#m3d-colormode');

    const getOrigin = () => ({
      x: parseInt(panel.querySelector('#m3d-ox').value) || 0,
      y: parseInt(panel.querySelector('#m3d-oy').value) || 64,
      z: parseInt(panel.querySelector('#m3d-oz').value) || 0,
    });

    const activePaletteForPreview = () => sanitizePalette(fullPalette || { rgb: WOOL_RGB, ids: WOOL_IDS_KNOWN, all: false });

    const colorFnFor = (vx) => {
      if (colorModeSel.value === 'single') {
        const id = parseInt(singleSel.value) || 47;
        const idx = WOOL_IDS_KNOWN.indexOf(id);
        const rgb = idx >= 0 ? WOOL_RGB[idx] : [180, 180, 180];
        return () => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      }
      const pal = activePaletteForPreview();
      const cache = new Map();
      return (col) => {
        if (!col) return 'rgb(150,150,150)';
        const key = (col[0] << 16) | (col[1] << 8) | col[2];
        if (!cache.has(key)) {
          const pi = nearestPaletteIndex(col[0], col[1], col[2], pal);
          const c = pal.rgb[pi];
          cache.set(key, `rgb(${c[0]},${c[1]},${c[2]})`);
        }
        return cache.get(key);
      };
    };

    let raws = null; // parsed triangles (undimmed)

    const recomputeVoxels = () => {
      if (!raws) return;
      const size = Math.max(4, Math.min(WORLD_MAX_Y, parseInt(sizeInput.value) || 48));
      try {
        currentVoxels = voxelize(raws, size, upSel.value, solidCheck.checked);
      } catch (e) {
        alert('Could not voxelize model: ' + e.message);
        currentVoxels = null;
        return;
      }
      renderIsoPreview(previewCanvas, currentVoxels, colorFnFor(currentVoxels));
      const v = currentVoxels;
      previewInfo.innerHTML =
        `<strong>${currentName || 'model'}</strong><br>` +
        `${v.dx}×${v.dy}×${v.dz} blocks · ${v.count} total` +
        (solidCheck.checked ? `` : ` (${v.surfaceCount} surface)`) +
        `<br>height ${v.dy} / max ${WORLD_MAX_Y - 1}`;
      previewWrap.classList.add('visible');
      dropzone.style.display = 'none';
      if (capturedWS && capturedWS.readyState === 1) startBtn.disabled = false;
    };

    const handleFiles = async (fileList) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;

      // Read all as needed (text for obj/mtl, buffer for others)
      const textFiles = new Map();
      const bufFiles = new Map();
      for (const f of files) {
        const name = f.name.toLowerCase();
        if (name.endsWith('.obj') || name.endsWith('.mtl') || name.endsWith('.gltf')) {
          textFiles.set(f.name, await f.text());
        } else {
          bufFiles.set(f.name, await f.arrayBuffer());
        }
      }

      const objEntry = [...textFiles.keys()].find((n) => n.toLowerCase().endsWith('.obj'));
      const glbEntry = [...bufFiles.keys()].find((n) => /\.glb$/i.test(n));
      const gltfEntry = [...textFiles.keys()].find((n) => /\.gltf$/i.test(n));
      const stlEntry = [...bufFiles.keys()].find((n) => /\.stl$/i.test(n));
      const fbxEntry = [...bufFiles.keys()].find((n) => /\.fbx$/i.test(n));

      try {
        if (objEntry) {
          currentName = objEntry;
          const mtlMap = new Map();
          for (const [n, t] of textFiles) {
            if (n.toLowerCase().endsWith('.mtl')) {
              for (const [k, v] of parseMTL(t)) mtlMap.set(k, v);
            }
          }
          raws = parseOBJ(textFiles.get(objEntry), mtlMap);
        } else if (glbEntry) {
          currentName = glbEntry;
          raws = parseGLB(bufFiles.get(glbEntry));
        } else if (stlEntry) {
          currentName = stlEntry;
          raws = parseSTL(bufFiles.get(stlEntry));
          upSel.value = 'z';
        } else if (fbxEntry) {
          currentName = fbxEntry;
          previewWrap.classList.add('visible');
          previewInfo.textContent = 'Loading FBX support (three.js)…';
          const THREE = await ensureFBXLoader();
          raws = parseFBX(THREE, bufFiles.get(fbxEntry));
        } else if (gltfEntry) {
          alert('Please export as .glb (binary glTF). Plain .gltf needs external .bin buffers.');
          return;
        } else {
          alert('Unsupported file. Please drop an .obj (+ .mtl), .stl, .glb or .fbx model.');
          return;
        }
      } catch (e) {
        previewWrap.classList.remove('visible');
        alert('Failed to parse model: ' + e.message);
        return;
      }

      if (!raws || !raws.length) { alert('No triangles found in that model.'); return; }

      // If model has no colors, default to single-block mode.
      const hasColors = raws.some((t) => t.color);
      if (!hasColors) {
        colorModeSel.value = 'single';
      } else {
        colorModeSel.value = 'model';
      }
      updateColorRowState();
      recomputeVoxels();
    };

    const updateColorRowState = () => {
      const single = colorModeSel.value === 'single';
      singleSel.disabled = !single;
      singleSel.style.opacity = single ? '1' : '0.5';
    };
    colorModeSel.addEventListener('change', () => {
      updateColorRowState();
      if (currentVoxels) renderIsoPreview(previewCanvas, currentVoxels, colorFnFor(currentVoxels));
    });

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
    previewCanvas.addEventListener('click', () => fileInput.click());

    sizeInput.addEventListener('change', recomputeVoxels);
    upSel.addEventListener('change', recomputeVoxels);
    solidCheck.addEventListener('change', recomputeVoxels);

    panel.querySelector('#m3d-get-pos').addEventListener('click', () => {
      const pos = getPlayerPos();
      if (!pos) { alert('Could not detect position yet. Make sure you are spawned.'); return; }
      panel.querySelector('#m3d-ox').value = Math.floor(pos.x);
      panel.querySelector('#m3d-oy').value = Math.floor(pos.y);
      panel.querySelector('#m3d-oz').value = Math.floor(pos.z);
    });

    const pauseBtn = panel.querySelector('#m3d-pause-btn');
    const stopBtn = panel.querySelector('#m3d-stop-btn');
    const clearBtn = panel.querySelector('#m3d-clear-btn');
    const progressSection = panel.querySelector('#m3d-progress-section');
    const progressBar = panel.querySelector('#m3d-progress-bar');
    const statusEl = panel.querySelector('#m3d-status');

    printer.onProgress = (p) => {
      progressSection.classList.add('visible');
      const pct = p.total ? Math.round((p.placed / p.total) * 100) : 0;
      progressBar.style.width = pct + '%';
      statusEl.innerHTML = `<strong>${pct}%</strong> — ${p.status || ''}`;
    };

    const startBuild = async () => {
      if (!currentVoxels || printer.running) return;
      if (!capturedWS || capturedWS.readyState !== 1) {
        alert('⚠️ Cannot start: Game WebSocket not captured yet.\n\nWait for the world to fully load, then try again.');
        return;
      }

      const mode = colorModeSel.value;
      const delay = parseInt(panel.querySelector('#m3d-delay').value) || 50;
      const retries = parseInt(panel.querySelector('#m3d-retries').value) || 12;
      const move = panel.querySelector('#m3d-move').checked;
      const origin = getOrigin();

      // Validate height / world bounds
      if (origin.y < 1 || origin.y + currentVoxels.dy > WORLD_MAX_Y) {
        alert(
          `⛔ Height limit (128): the model is ${currentVoxels.dy} blocks tall, so its base Y must be between 1 and ${WORLD_MAX_Y - currentVoxels.dy}.\n\n` +
          `Currently Y=${origin.y}. Adjust the origin or reduce Max Size.`
        );
        return;
      }
      if (origin.x < 0 || origin.z < 0 || origin.x + currentVoxels.dx > 1024 || origin.z + currentVoxels.dz > 1024) {
        alert('⛔ The model would extend outside the world (X/Z 0..1023). Move the origin or reduce Max Size.');
        return;
      }

      // Build the per-voxel block list
      let pal = null;
      if (mode === 'model') {
        if (!fullPalette) {
          previewInfo.textContent = 'Loading block palette… 0%';
          try {
            pal = await buildFullPalette((d, t) => { previewInfo.textContent = `Loading block palette… ${Math.round((d / t) * 100)}%`; });
          } catch (e) {
            alert('Could not load all-blocks palette: ' + e.message + '\nFalling back to the 16 wools.');
            pal = { rgb: WOOL_RGB, ids: WOOL_IDS_KNOWN, all: false };
          }
        } else {
          pal = fullPalette;
        }
        pal = sanitizePalette(pal);
      }

      const items = [];
      for (const [k, col] of currentVoxels.voxels) {
        const z = k % 4096;
        const y = Math.floor(k / 4096) % 4096;
        const x = Math.floor(k / (4096 * 4096));
        let blockId;
        if (mode === 'single') {
          blockId = parseInt(singleSel.value) || 47;
        } else {
          const c = col || [150, 150, 150];
          blockId = pal.ids[nearestPaletteIndex(c[0], c[1], c[2], pal)];
        }
        items.push({ x, y, z, blockId });
      }

      startBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';

      await printer.build(items, origin, delay, retries, move);

      startBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
      updateStatusUI();
    };

    startBtn.addEventListener('click', startBuild);

    pauseBtn.addEventListener('click', () => {
      printer.togglePause();
      pauseBtn.textContent = printer.paused ? '▶ Resume' : '⏸ Pause';
    });

    stopBtn.addEventListener('click', () => {
      printer.stop();
      startBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';
    });

    clearBtn.addEventListener('click', async () => {
      if (printer.running) return;
      if (!currentVoxels) { alert('Load a model first.'); return; }
      const origin = getOrigin();
      const { dx, dy, dz } = currentVoxels;
      if (!confirm(`Clear a ${dx}×${dy}×${dz} box starting at (${origin.x}, ${origin.y}, ${origin.z})? This sets those blocks to air.`)) return;
      if (origin.y < 1 || origin.y + dy > WORLD_MAX_Y) {
        alert('Origin Y would exceed the world height. Adjust the origin first.');
        return;
      }
      const delay = parseInt(panel.querySelector('#m3d-delay').value) || 50;
      const move = panel.querySelector('#m3d-move').checked;
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      await printer.clearBox(origin, dx, dy, dz, delay, move);
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
    });

    updateColorRowState();
    updateStatusUI();
    return panel;
  }

  /* ─────────────────────────────────────────────
   * 8. BOOTSTRAP
   * ───────────────────────────────────────────── */
  const waitForGame = () =>
    new Promise((resolve) => {
      const check = () => {
        const mc = targetWindow.__mc || window.__mc;
        if (targetWindow.__ready || window.__ready || (wasmExports && capturedWS) || (mc && capturedWS)) return resolve();
        setTimeout(check, 500);
      };
      check();
    });

  async function main() {
    console.log('[Model3D] Userscript initialized. Waiting for game to load…');
    await waitForGame();
    await new Promise((r) => setTimeout(r, 1500));

    const printer = new ModelPrinter();
    createUI(printer);

    setTimeout(() => {
      const pos = getPlayerPos();
      if (pos) {
        const ox = document.getElementById('m3d-ox');
        const oy = document.getElementById('m3d-oy');
        const oz = document.getElementById('m3d-oz');
        if (ox && oy && oz) { ox.value = Math.floor(pos.x); oy.value = Math.floor(pos.y); oz.value = Math.floor(pos.z); }
      }
    }, 2500);

    setInterval(updateStatusUI, 1000);
  }

  main();
})();
