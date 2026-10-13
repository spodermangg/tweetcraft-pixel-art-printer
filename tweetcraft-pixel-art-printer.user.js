// ==UserScript==
// @name         TweetCraft Pixel Art Printer
// @namespace    https://tweetcraft.jai.vin
// @version      1.6.7
// @description  Upload an image → auto-convert to wool colors → print pixel art like a bot (moves left→right, places blocks, fixes missed blocks per line)
// @author       @vibecodingonsol
// @match        https://tweetcraft.jai.vin/r/*
// @match        https://tweetcraft.jai.vin/play/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // Support both page window (via unsafeWindow) and userscript global scope
  const targetWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  /* ─────────────────────────────────────────────
   * 1. EARLY INTERCEPTIONS (WebSocket & WASM)
   * ───────────────────────────────────────────── */
  let capturedWS = null;
  let activePrinter = null;
  let roomInfo = { name: '', lock: 0, mode: 'creative' };
  let playerInfo = { id: 0, name: '', handle: '', verified: false };
  let packetsSentCount = 0;
  let lastHeldBlock = null;
  let lastSinv = null;
  let lastSelSlot = null;

  const OrigWS = targetWindow.WebSocket || window.WebSocket;

  // The game socket lives at `/ws/<room>`. The voice socket lives at
  // `/ws/voice/<room>` and the moderation tap at `/api/voice/.../tap`.
  // Only the game socket accepts (and persists) block edits, so never let
  // the voice socket replace it.
  function isGameSocket(ws) {
    const url = String(ws && ws.url || '');
    return url.includes('/ws/') && !url.includes('/voice/');
  }

  function captureSocket(ws, reason) {
    if (!ws || !isGameSocket(ws)) return false;
    const prev = capturedWS;
    if (prev === ws) return true;
    // Keep an existing game socket unless it's closed/closing.
    if (prev && (prev.readyState === 0 || prev.readyState === 1)) return false;
    capturedWS = ws;
    console.log('[PixelArt] Captured game WebSocket (' + reason + '):', ws.url);
    attachSocketListeners(ws);
    updateStatusUI();
    return true;
  }

  function attachSocketListeners(ws) {
    if (!ws || ws._pixelArtMonitored) return;
    ws._pixelArtMonitored = true;
    try {
      const origSend = ws.send;
      ws.send = function (data) {
        const fromUs = !!targetWindow.__pixelArtSending;
        if (data instanceof ArrayBuffer) {
          try {
            console.log('[PIXEL-DEBUG]' + (fromUs ? ' US' : ' GAME') + ' SEND BIN:', Array.from(new Uint8Array(data)));
          } catch (e) { }
        } else if (typeof data === 'string') {
          if (data.length < 300) console.log('[PIXEL-DEBUG]' + (fromUs ? ' US' : ' GAME') + ' SEND:', data);
          else console.log('[PIXEL-DEBUG]' + (fromUs ? ' US' : ' GAME') + ' SEND:', data.slice(0, 300) + '…');
        }
        return origSend.apply(this, arguments);
      };
    } catch (e) { }

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'welcome' && msg.room && msg.id !== undefined) {
            // Definitive proof this is the game socket (voice never sends this).
            if (capturedWS !== ws) {
              capturedWS = ws;
              console.log('[PixelArt] Confirmed game WebSocket via welcome message:', ws.url);
              updateStatusUI();
            }
            console.log('[PixelArt] Welcome received from server:', msg);
            roomInfo.name = msg.room?.name || '';
            roomInfo.lock = msg.room?.lock ?? 0;
            roomInfo.mode = msg.room?.mode || 'creative';
            playerInfo.id = msg.id || 0;
            playerInfo.name = msg.you?.name || '';
            playerInfo.handle = msg.you?.h || '';
            playerInfo.verified = !!(msg.you?.h || msg.owner);
            console.log('[PIXEL-DEBUG] ROOM MODE =', roomInfo.mode, '| survival flag set =', !!(targetWindow.__mc || window.__mc)?.S?.sv);
            updateStatusUI();
          }
          // Log relevant incoming messages for debugging
          if (msg.t && ['welcome', 'place', 'placeack', 'digack', 'sys', 'hitdeny', 'sinv', 'synced', 'hp', 'dead'].includes(msg.t)) {
            const str = typeof event.data === 'string' ? event.data : '';
            console.log('[PIXEL-DEBUG] RECV:', str.length < 250 ? str : str.slice(0, 250) + '…');
          }
          if (msg.t === 'sinv') {
            lastSinv = { s: Array.isArray(msg.s) ? msg.s : null, sel: msg.sel };
            console.log('[PIXEL-DEBUG] SINV slots =', msg.s ? msg.s.map(v => v && v[0]).join(',') : '(none)', '| sel =', msg.sel);
          }
          if (msg.t === 'old' || (msg.t === 'sys' && /out of date|reload|latest version|update available/i.test(msg.m || ''))) {
            // The game updated on the server but this tab is still running old
            // cached JS, so the server rejects every block edit. Only a reload
            // of the game fixes it — not re-verifying the X account.
            console.warn('[PixelArt] Out-of-date client detected:', msg.m || '(old protocol)');
            if (activePrinter && activePrinter.running) activePrinter.stop();
            alert(
              '⚠️ GAME UPDATED — RELOAD REQUIRED\n\n' +
              'TweetCraft was updated and this tab is still running the old game version.\n' +
              'The server rejects block edits until you reload.\n\n' +
              `Server said: "${msg.m || 'old client'}"\n\n` +
              '→ Force-reload this tab (Cmd/Ctrl + Shift + R) to load the new version, then print again.'
            );
            return;
          }
          if (msg.t === 'sys') {
            console.warn('[PixelArt] Server system message:', msg.m);
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
        } catch (err) { }
      } else if (event.data instanceof ArrayBuffer) {
        // Check for DENY packet (type 4) or "old" style rejection
        try {
          const dv = new DataView(event.data);
          const t = dv.getUint8(0);
          if (t === 4 && event.data.byteLength >= 6) {
            // DENY packet - server rejected the edit
            console.warn('[PixelArt] DENY packet received from server');
            if (activePrinter && activePrinter.running) {
              activePrinter.stop();
              alert(
                '⚠️ SERVER REJECTED BLOCK PLACEMENT (DENY)\n\n' +
                'The server rejected your block edit packet.\n\n' +
                'This usually means the game version is out of date or the world is locked.\n' +
                'Force-reload this tab (Cmd/Ctrl + Shift + R) and try again.'
              );
            }
          }
        } catch (e) { }
      }
    });

    ws.addEventListener('close', () => {
      console.log('[PixelArt] WebSocket connection closed.');
      if (capturedWS === ws) capturedWS = null;
      updateStatusUI();
    });
  }

  // 1. Hook the constructor on both targetWindow and window
  const wrapConstructor = (win) => {
    const NativeWS = win.WebSocket;
    if (!NativeWS) return;

    win.WebSocket = function (...args) {
      const ws = new NativeWS(...args);
      try {
        const url = String(args[0] || '');
        if (url.includes('/ws/')) {
          if (url.includes('/voice/')) {
            console.log('[PixelArt] Ignoring voice WebSocket:', url);
          } else {
            captureSocket(ws, 'constructor');
          }
        }
      } catch (e) {
        console.warn('[PixelArt] WS intercept error:', e);
      }
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

  // 2. Also hook prototype.send (guarantees capture the moment TweetCraft sends hello/pos)
  const hookPrototypeSend = (win) => {
    const proto = win.WebSocket?.prototype;
    if (!proto || proto._pixelArtHooked) return;
    proto._pixelArtHooked = true;

    const origSend = proto.send;
    proto.send = function (data) {
      if (!capturedWS && this.url && isGameSocket(this)) {
        captureSocket(this, 'prototype.send');
      }
      return origSend.apply(this, arguments);
    };
  };

  hookPrototypeSend(targetWindow);
  if (targetWindow !== window) hookPrototypeSend(window);

  // 3. Intercept WebAssembly instantiation
  let wasmExports = null;
  let wasmMemory = null;

  const handleWasmResult = (result) => {
    try {
      const inst = result?.instance || result;
      if (inst?.exports?.set_block && inst?.exports?.get_block) {
        console.log('[PixelArt] Captured WASM engine exports');
        wasmExports = inst.exports;
        wasmMemory = inst.exports.memory;
      }
    } catch (e) {
      console.warn('[PixelArt] WASM capture error:', e);
    }
    return result;
  };

  const hookWasm = (win) => {
    if (!win.WebAssembly) return;
    const origInstantiate = win.WebAssembly.instantiate;
    win.WebAssembly.instantiate = async function (...args) {
      const res = await origInstantiate.apply(this, args);
      return handleWasmResult(res);
    };
    if (win.WebAssembly.instantiateStreaming) {
      const origStreaming = win.WebAssembly.instantiateStreaming;
      win.WebAssembly.instantiateStreaming = async function (...args) {
        const res = await origStreaming.apply(this, args);
        return handleWasmResult(res);
      };
    }
  };

  hookWasm(targetWindow);
  if (targetWindow !== window) hookWasm(window);

  /* ─────────────────────────────────────────────
   * 2. LOW-LEVEL ENGINE & NETWORK DISPATCH
   * ───────────────────────────────────────────── */
  function sendEditPacket(x, y, z, blockId) {
    const ws = capturedWS;
    if (!ws) {
      console.error('[PixelArt] sendEditPacket failed: capturedWS is null (socket not found)');
      return false;
    }
    if (!isGameSocket(ws)) {
      console.error('[PixelArt] sendEditPacket failed: captured socket is not the game socket:', ws.url);
      return false;
    }
    if (ws.readyState !== 1) { // 1 = WebSocket.OPEN
      console.error('[PixelArt] sendEditPacket failed: ws.readyState is', ws.readyState);
      return false;
    }

    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);

    if (ix < 0 || ix >= 1024 || iz < 0 || iz >= 1024 || iy < 1 || iy >= 128) {
      console.error('[PixelArt] sendEditPacket: Out of bounds coordinates:', ix, iy, iz);
      return false;
    }

    // The game (survival-style build rooms) places a block via:
    //   1) {"t":"inv","hotbar":[9 block ids],"slot":n}  -> tells the server what we hold
    //   2) {"t":"place","x","y","z","f"}                -> places held block against face f of block (x,y,z)
    // window.__mc only exists in DEV, so we replicate the exact wire messages ourselves.
    const FACES = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

    targetWindow.__pixelArtSending = true;
    try {
      if (blockId === 0) {
        // Clearing a block: the server removes blocks via the dig flow. Best-effort:
        // send a start+done dig on the target (creative rooms accept this as air).
        ws.send(JSON.stringify({ t: 'inv', hotbar: [0, 0, 0, 0, 0, 0, 0, 0, 0], slot: 0 }));
        ws.send(buildPosPacket(ix + 0.5, iy + 0.5, iz + 0.5));
        ws.send(JSON.stringify({ t: 'dig', s: 0, x: ix, y: iy, z: iz, f: 1, i: 1 }));
        ws.send(JSON.stringify({ t: 'dig', s: 2, x: ix, y: iy, z: iz, f: 1, i: 1 }));
        packetsSentCount++;
        return true;
      }

      // Pick a solid neighbour so we have a valid face to place against.
      let nx = ix, ny = iy, nz = iz, face = 1, found = false;
      for (let fi = 0; fi < 6; fi++) {
        const d = FACES[fi];
        const cx = ix - d[0], cy = iy - d[1], cz = iz - d[2];
        if (cy < 0 || cy >= 128) continue;
        const b = getBlock(cx, cy, cz);
        if (b > 0 && b !== 255) { nx = cx; ny = cy; nz = cz; face = fi; found = true; break; }
      }
      if (!found) {
        // No solid neighbour: try to place directly (server may still accept it).
        nx = ix; ny = iy; nz = iz; face = 1;
      }

      // Choose which inventory slot holds this block. The server is authoritative
      // about the hotbar (survival rooms ignore client-setSlot), so prefer a slot
      // that already contains the block; otherwise fabricate a hotbar via `inv`.
      let slot = -1;
      if (lastSinv && Array.isArray(lastSinv.s)) {
        for (let i = 0; i < 9; i++) {
          const entry = lastSinv.s[i];
          if (entry && entry[0] === blockId) { slot = i; break; }
        }
      }
      if (slot === -1) {
        slot = 0;
        ws.send(JSON.stringify({ t: 'inv', hotbar: [blockId, blockId, blockId, blockId, blockId, blockId, blockId, blockId, blockId], slot: 0 }));
        lastSelSlot = null;
        lastSinv = null;
      }
      if (lastSelSlot !== slot) {
        ws.send(JSON.stringify({ t: 'sel', i: slot }));
        lastSelSlot = slot;
      }
      ws.send(buildPosPacket(nx + 0.5, ny + 0.5, nz + 0.5));
      ws.send(JSON.stringify({ t: 'place', x: nx, y: ny, z: nz, f: face }));
      console.log('[PIXEL-DEBUG] US place block', blockId, 'slot', slot, 'target', ix, iy, iz, 'against', nx, ny, nz, 'face', face, found ? '(solid nbr)' : '(no nbr)');
      packetsSentCount++;
      return true;
    } catch (e) {
      console.warn('[PixelArt] place failed:', e);
      return false;
    } finally {
      targetWindow.__pixelArtSending = false;
    }
  }

  function placeBlock(x, y, z, blockId) {
    const blockName = getBlockName(blockId);
    if (blockId === 0) {
      console.log(`[PixelArt] Clearing (air) at (${x}, ${y}, ${z})`);
    } else {
      console.log(`[PixelArt] Placing ${blockName} (id ${blockId}) at (${x}, ${y}, ${z})`);
    }

    // 1. MUST successfully send across the real WebSocket
    const sent = sendEditPacket(x, y, z, blockId);
    if (!sent) {
      console.error(`[PixelArt] ABORT: Could not send packet to server for (${x}, ${y}, ${z})`);
      if (activePrinter && activePrinter.running) {
        activePrinter.stop();
        alert(
          `⚠️ PRINTING STOPPED:\n\n` +
          `Failed to send block edit packet to the server for (${x}, ${y}, ${z}).\n\n` +
          `Socket status: ${capturedWS ? 'readyState ' + capturedWS.readyState : 'NULL'}\n\n` +
          `This safeguards against placing blocks only on your local screen.`
        );
      }
      return false;
    }

    // 2. Only after network packet is sent, update local WASM engine for instant local rendering
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
    if (mc && mc.eng && mc.eng.x) {
      return mc.eng.x.get_block(x, y, z);
    }
    if (wasmExports && typeof wasmExports.get_block === 'function') {
      return wasmExports.get_block(x, y, z);
    }
    return -1;
  }

  function getPlayerState() {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.st) {
      return mc.eng.st;
    }
    if (wasmExports && wasmExports.memory && wasmExports.state_ptr) {
      return new Float64Array(wasmExports.memory.buffer, wasmExports.state_ptr(), 12);
    }
    return null;
  }

  function getPlayerPos() {
    const st = getPlayerState();
    if (st) {
      return { x: st[0], y: st[1], z: st[2] };
    }
    return null;
  }

  function movePlayer(x, y, z) {
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.x) {
      try { mc.eng.x.player_fly(1); } catch (e) { }
      mc.eng.x.player_set(x, y, z);
      const st = mc.eng.st;
      if (st) { st[3] = 0; st[4] = 0; st[5] = 0; }
      return;
    }
    if (wasmExports) {
      if (typeof wasmExports.player_fly === 'function') {
        try { wasmExports.player_fly(1); } catch (e) { }
      }
      if (typeof wasmExports.player_set === 'function') {
        wasmExports.player_set(x, y, z);
      }
      const st = getPlayerState();
      if (st) { st[3] = 0; st[4] = 0; st[5] = 0; }
    }
  }

  // Builds the 18-byte binary POS frame (type 1) exactly like net.js:pos(),
  // so the server learns where we are before we place. The printer moves the
  // player through the WASM engine, but the game only streams POS periodically
  // — without an up-to-date position the server drops placements that are out
  // of reach (which is why only the first few columns stuck).
  function buildPosPacket(lookX, lookY, lookZ) {
    const st = getPlayerState();
    const px = st ? st[0] : 0, py = st ? st[1] : 0, pz = st ? st[2] : 0;
    const dx = lookX - px, dy = lookY - (py + 1.62), dz = lookZ - pz;
    const horiz = Math.hypot(dx, dz) || 1e-6;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, horiz);
    const flags = st ? ((st[9] ? 1 : 0) | (st[7] ? 2 : 0)) : 0;
    const buf = new ArrayBuffer(18);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setFloat32(1, px, true);
    dv.setFloat32(5, py, true);
    dv.setFloat32(9, pz, true);
    dv.setInt16(13, Math.round(yaw * 1e4), true);
    dv.setInt16(15, Math.round(pitch * 1e4), true);
    dv.setUint8(17, flags);
    return buf;
  }

  /* ─────────────────────────────────────────────
   * 3. WOOL COLOR PALETTE & RUNTIME DISCOVERY
   * ───────────────────────────────────────────── */
  const WOOL_NAMES = [
    'White Wool',
    'Orange Wool',
    'Magenta Wool',
    'Light Blue Wool',
    'Yellow Wool',
    'Lime Wool',
    'Pink Wool',
    'Gray Wool',
    'Light Gray Wool',
    'Cyan Wool',
    'Purple Wool',
    'Blue Wool',
    'Brown Wool',
    'Green Wool',
    'Red Wool',
    'Black Wool',
  ];

  const WOOL_RGB = [
    [233, 236, 236], // White
    [241, 118, 19],  // Orange
    [189, 68, 179],  // Magenta
    [58, 175, 217],  // Light Blue
    [254, 216, 61],  // Yellow
    [112, 185, 25],  // Lime
    [237, 141, 172], // Pink
    [62, 68, 71],    // Gray
    [142, 142, 134], // Light Gray
    [21, 137, 145],  // Cyan
    [121, 42, 172],  // Purple
    [53, 57, 157],   // Blue
    [114, 71, 40],   // Brown
    [85, 109, 27],   // Green
    [160, 39, 34],   // Red
    [20, 21, 25],    // Black
  ];

  // Exact consecutive wool block IDs (47 through 62) directly verified from TweetCraft's engine.wasm
  const WOOL_IDS_KNOWN = [47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62];
  let woolBlockIds = [...WOOL_IDS_KNOWN];

  // Active palette used for color mapping.
  // Shape: { rgb: [[r,g,b], ...], ids: [blockId, ...], all: boolean }
  // Index i in a grid maps to block id ids[i] and color rgb[i].
  let activePalette = { rgb: WOOL_RGB, ids: woolBlockIds, all: false };

  // Texture tinting, mirrors the game's engine.js TINT table so averaged
  // colors match what the world actually renders.
  const BLOCK_TINT = {
    grass_block_top: [145, 189, 89], short_grass: [145, 189, 89], fern: [145, 189, 89],
    tall_grass_bottom: [145, 189, 89], tall_grass_top: [145, 189, 89],
    large_fern_bottom: [145, 189, 89], large_fern_top: [145, 189, 89],
    spruce_leaves: [97, 153, 97], oak_leaves: [119, 171, 47], birch_leaves: [128, 167, 85],
    water_still: [63, 118, 228], water_flow: [63, 118, 228],
  };
  const TEXCOLOR_KEY = 'tcpixelart.texcolor.v1';
  // Blocks that must never be printed (unbreakable / not legitimately placeable).
  const EXCLUDED_BLOCKS = new Set(['bedrock']);
  let fullPalette = null;
  let fullPalettePromise = null;

  function discoverWoolIds() {
    let names = null;
    const mc = targetWindow.__mc || window.__mc;
    if (mc && mc.eng && mc.eng.blockNames) {
      names = mc.eng.blockNames;
    } else if (wasmExports && wasmExports.block_names && wasmExports.memory) {
      try {
        const mem = wasmExports.memory;
        const b = new Uint8Array(mem.buffer);
        const p = wasmExports.block_names();
        let q = p;
        while (b[q]) q++;
        names = new TextDecoder().decode(b.subarray(p, q)).split('\n');
      } catch (e) {
        console.warn('[PixelArt] Failed reading block names from WASM:', e);
      }
    }

    if (names && names.length > 0) {
      const ids = WOOL_NAMES.map((name) => {
        return names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
      });
      if (ids.every((id) => id >= 0)) {
        woolBlockIds = ids;
        console.log('[PixelArt] Dynamically mapped wool IDs:', woolBlockIds);
        return true;
      }
    }

    woolBlockIds = [...WOOL_IDS_KNOWN];
    console.log('[PixelArt] Using verified wool IDs [47..62]:', woolBlockIds);
    return true;
  }

  // Read full block/texture tables from the game (DEV `__mc.eng` or production WASM exports).
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
      } catch (e) {
        console.warn('[PixelArt] Failed reading block tables from WASM:', e);
      }
    }
    return null;
  }

  // Cached id → block name lookup for logging.
  let cachedBlockNames = null;
  function getBlockName(id) {
    if (!cachedBlockNames) {
      const d = getBlockData();
      if (d && d.blockNames) cachedBlockNames = d.blockNames;
    }
    if (cachedBlockNames) return cachedBlockNames[id] || `#${id}`;
    return `#${id}`;
  }

  // Never build with forbidden blocks; substitute a safe equivalent instead.
  const BLOCK_SUBSTITUTES = { 12: 34 }; // Bedrock → Block of Coal
  function sanitizePalette(pal) {
    if (!pal || !pal.ids) return pal;
    let changed = false;
    const ids = pal.ids.map((id) => {
      if (BLOCK_SUBSTITUTES[id] != null) { changed = true; return BLOCK_SUBSTITUTES[id]; }
      return id;
    });
    return changed ? { rgb: pal.rgb, ids, all: pal.all } : pal;
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
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 16, 16);
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    const tint = BLOCK_TINT[name];
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 26) continue; // skip transparent pixels
      let pr = d[i], pg = d[i + 1], pb = d[i + 2];
      if (tint) { pr *= tint[0] / 255; pg *= tint[1] / 255; pb *= tint[2] / 255; }
      r += pr; g += pg; b += pb; n++;
    }
    if (!n) return null;
    const rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    cache[name] = rgb;
    return rgb;
  }

  // Build a palette containing every placeable solid block in the game.
  // Colors are averaged from the real 16x16 textures (cached in localStorage).
  function buildFullPalette(onProgress) {
    if (fullPalette) return Promise.resolve(fullPalette);
    if (fullPalettePromise) return fullPalettePromise;

    fullPalettePromise = (async () => {
      const data = getBlockData();
      if (!data) throw new Error('block tables not ready (wait for the world to finish loading)');

      const { blockNames, texNames, ft, kind } = data;
      let cache = {};
      try { cache = JSON.parse(localStorage.getItem(TEXCOLOR_KEY)) || {}; } catch (e) { cache = {}; }

      // Collect unique solid-block textures (side face), grass uses its (tinted) top.
      const entries = [];
      const seenTex = new Set();
      for (let id = 1; id < blockNames.length; id++) {
        if (kind[id] !== 1) continue; // SOLID only
        const bname = blockNames[id] || '';
        if (EXCLUDED_BLOCKS.has(bname.toLowerCase())) continue; // e.g. Bedrock
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
        if (!col) {
          try { col = await averageTextureColor(e.tex, cache); } catch (err) { col = null; }
        }
        done++;
        if (onProgress) onProgress(done, entries.length);
        if (col) { e.col = col; }
      }));

      for (const e of entries) {
        if (e.col) { rgb.push(e.col); ids.push(e.id); }
      }

      try { localStorage.setItem(TEXCOLOR_KEY, JSON.stringify(cache)); } catch (e) { /* ignore */ }
      if (rgb.length < 4) throw new Error('could not resolve block colors');

      fullPalette = { rgb, ids, all: true };
      console.log(`[PixelArt] All-blocks palette ready: ${rgb.length} colors`);
      return fullPalette;
    })();

    fullPalettePromise.catch(() => { fullPalettePromise = null; });
    return fullPalettePromise;
  }

  /* ─────────────────────────────────────────────
   * 4. IMAGE CONVERSION & DITHERING
   * ───────────────────────────────────────────── */
  function nearestWool(r, g, b, a) {
    if (a < 128) return -1; // Transparent → Air
    const pal = activePalette.rgb;
    let bestDist = Infinity;
    let bestIdx = 0;
    for (let i = 0; i < pal.length; i++) {
      const [wr, wg, wb] = pal[i];
      const dr = r - wr;
      const dg = g - wg;
      const db = b - wb;
      const rMean = (r + wr) / 2;
      const dist =
        (2 + rMean / 256) * dr * dr +
        4 * dg * dg +
        (2 + (255 - rMean) / 256) * db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  function imageToGrid(img, maxW, maxH, useDithering = true) {
    const aspect = img.width / img.height;
    let w = maxW;
    let h = Math.round(w / aspect);
    if (h > maxH) {
      h = maxH;
      w = Math.round(h * aspect);
    }
    w = Math.max(1, Math.min(maxW, w));
    h = Math.max(1, Math.min(maxH, h));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    const grid = [];

    if (!useDithering) {
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          row.push(nearestWool(data[i], data[i + 1], data[i + 2], data[i + 3]));
        }
        grid.push(row);
      }
    } else {
      // Floyd-Steinberg error diffusion
      const fData = new Float32Array(w * h * 4);
      for (let i = 0; i < data.length; i++) fData[i] = data[i];

      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const a = fData[idx + 3];
          if (a < 128) {
            row.push(-1);
            continue;
          }
          const r = Math.max(0, Math.min(255, fData[idx]));
          const g = Math.max(0, Math.min(255, fData[idx + 1]));
          const b = Math.max(0, Math.min(255, fData[idx + 2]));
          const woolIdx = nearestWool(r, g, b, 255);
          row.push(woolIdx);

          const [targetR, targetG, targetB] = activePalette.rgb[woolIdx];
          const errR = r - targetR;
          const errG = g - targetG;
          const errB = b - targetB;

          const addErr = (px, py, weight) => {
            if (px < 0 || px >= w || py < 0 || py >= h) return;
            const pIdx = (py * w + px) * 4;
            fData[pIdx] += errR * weight;
            fData[pIdx + 1] += errG * weight;
            fData[pIdx + 2] += errB * weight;
          };
          addErr(x + 1, y, 7 / 16);
          addErr(x - 1, y + 1, 3 / 16);
          addErr(x, y + 1, 5 / 16);
          addErr(x + 1, y + 1, 1 / 16);
        }
        grid.push(row);
      }
    }
    return { grid, w, h };
  }

  function drawPreview(canvas, grid, w, h, pal = activePalette) {
    const scale = Math.max(1, Math.min(8, Math.floor(256 / Math.max(w, h))));
    canvas.width = w * scale;
    canvas.height = h * scale;
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    const ctx = canvas.getContext('2d');
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const wi = grid[y][x];
        if (wi < 0) {
          ctx.fillStyle = (x + y) % 2 ? '#222' : '#333';
        } else {
          const [r, g, b] = pal.rgb[wi];
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }

  /* ─────────────────────────────────────────────
   * 5. PRINTER BOT CLASS
   * ───────────────────────────────────────────── */
  class PixelPrinter {
    constructor() {
      this.running = false;
      this.paused = false;
      this.grid = null;
      this.w = 0;
      this.h = 0;
      this.blockIds = [...woolBlockIds];
      this.origin = { x: 0, y: 64, z: 0 };
      this.direction = 'north';
      this.sweepMode = 'zigzag'; // 'ltr' (printer) or 'zigzag'
      this.movePlayer = true;
      this.standoff = 2.5;
      this.delayMs = 180;
      this.lineRetries = 30;
      this.progress = { row: 0, col: 0, placed: 0, total: 0, status: '' };
      this.onProgress = null;
      this._cancel = false;
    }

    _sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async _waitUnpaused() {
      while (this.paused && !this._cancel) await this._sleep(100);
    }

    _notify() {
      if (this.onProgress) this.onProgress({ ...this.progress });
    }

    stop() {
      this._cancel = true;
      this.running = false;
      this.paused = false;
      this.progress.status = '⛔ Stopped';
      this._notify();
    }

    togglePause() {
      this.paused = !this.paused;
      this.progress.status = this.paused ? '⏸ Paused' : 'Printing...';
      this._notify();
    }

    _blockCoords(col, rowFromBottom) {
      const y = this.origin.y + rowFromBottom;
      switch (this.direction) {
        case 'north': // wall extends +X, facing south (+Z)
          return { x: this.origin.x + col, y, z: this.origin.z };
        case 'south': // wall extends -X, facing north (-Z)
          return { x: this.origin.x - col, y, z: this.origin.z };
        case 'east':  // wall extends +Z, facing west (-X)
          return { x: this.origin.x, y, z: this.origin.z + col };
        case 'west':  // wall extends -Z, facing east (+X)
          return { x: this.origin.x, y, z: this.origin.z - col };
        case 'floor': // flat on ground, +X / +Z
          return { x: this.origin.x + col, y: this.origin.y, z: this.origin.z + (this.h - 1 - rowFromBottom) };
        default:
          return { x: this.origin.x + col, y, z: this.origin.z };
      }
    }

    _playerCoords(col, rowFromBottom) {
      const b = this._blockCoords(col, rowFromBottom);
      switch (this.direction) {
        case 'north':
          return { x: b.x + 0.5, y: b.y, z: b.z + this.standoff };
        case 'south':
          return { x: b.x + 0.5, y: b.y, z: b.z - this.standoff };
        case 'east':
          return { x: b.x - this.standoff, y: b.y, z: b.z + 0.5 };
        case 'west':
          return { x: b.x + this.standoff, y: b.y, z: b.z + 0.5 };
        case 'floor':
          return { x: b.x + 0.5, y: b.y + this.standoff, z: b.z + 0.5 };
        default:
          return { x: b.x + 0.5, y: b.y, z: b.z + this.standoff };
      }
    }

    async start(grid, w, h, origin, direction, delayMs, lineRetries, sweepMode, movePlayer, blockIds) {
      this.grid = grid;
      this.w = w;
      this.h = h;
      this.origin = origin;
      this.direction = direction;
      this.delayMs = delayMs;
      this.lineRetries = lineRetries;
      this.sweepMode = sweepMode;
      this.movePlayer = movePlayer;
      this.blockIds = blockIds && blockIds.length ? blockIds : woolBlockIds;
      this.running = true;
      this.paused = false;
      this._cancel = false;

      const totalBlocks = grid.flat().filter((v) => v >= 0).length;
      this.progress = { row: 0, col: 0, placed: 0, total: totalBlocks, status: 'Starting printer...' };
      this._notify();

      await this._printAll();

      if (!this._cancel) {
        this.progress.status = '✅ Printing complete! All blocks sent to server.';
        this._notify();
      }
      this.running = false;
    }

    async clearArea(w, h, origin, direction, delayMs = 50, retries = 30, followPlayer = false) {
      this.w = w;
      this.h = h;
      this.origin = origin;
      this.direction = direction;
      this.lineRetries = retries;
      this.movePlayer = followPlayer;
      this.running = true;
      this.paused = false;
      this._cancel = false;
      const totalBlocks = w * h;
      this.progress = { row: 0, col: 0, placed: 0, total: totalBlocks, status: 'Clearing area...' };
      this._notify();

      // Row by row from bottom to top, mirroring the building routine
      for (let r = 0; r < h && !this._cancel; r++) {
        const currentLineNum = r + 1;

        // Move player carriage to start of line
        if (this.movePlayer) {
          const startP = this._playerCoords(0, r);
          movePlayer(startP.x, startP.y, startP.z);
          await this._sleep(100);
        }

        this.progress.row = currentLineNum;
        this.progress.status = `Clearing row ${currentLineNum}/${h}...`;
        this._notify();

        // 1. Sweep across the line setting air
        for (let c = 0; c < w && !this._cancel; c++) {
          await this._waitUnpaused();
          if (this._cancel) return;

          const bPos = this._blockCoords(c, r);

          if (this.movePlayer) {
            const pPos = this._playerCoords(c, r);
            movePlayer(pPos.x, pPos.y, pPos.z);
          }

          placeBlock(bPos.x, bPos.y, bPos.z, 0); // 0 = Air
          this.progress.placed++;
          this.progress.col = c;
          this._notify();
          await this._sleep(delayMs);
        }

        // 2. Line verification & retry BEFORE moving to next line.
        //    The server rate-limits edits and rejects some with a DENY (which
        //    the game reverts locally), so re-scan this row and re-clear what's left.
        for (let retry = 1; retry <= this.lineRetries && !this._cancel; retry++) {
          await this._sleep(120);

          const missingCols = [];
          for (let c = 0; c < w; c++) {
            const bPos = this._blockCoords(c, r);
            if (getBlock(bPos.x, bPos.y, bPos.z) !== 0) missingCols.push(c);
          }

          if (missingCols.length === 0) break;

          this.progress.status = `Row ${currentLineNum}: re-clearing ${missingCols.length} remaining blocks (pass ${retry})...`;
          this._notify();

          for (const c of missingCols) {
            await this._waitUnpaused();
            if (this._cancel) return;

            const bPos = this._blockCoords(c, r);

            if (this.movePlayer) {
              const pPos = this._playerCoords(c, r);
              movePlayer(pPos.x, pPos.y, pPos.z);
            }

            placeBlock(bPos.x, bPos.y, bPos.z, 0);
            await this._sleep(delayMs);
          }
        }

        await this._sleep(60);
      }

      this.running = false;
      this.progress.status = this._cancel ? '⛔ Stopped' : '✅ Area cleared!';
      this._notify();
    }

    async _printAll() {
      // Row by row from bottom to top
      for (let imgRow = this.h - 1; imgRow >= 0 && !this._cancel; imgRow--) {
        const rowFromBottom = this.h - 1 - imgRow;
        const currentLineNum = rowFromBottom + 1;

        let cols = [];
        for (let c = 0; c < this.w; c++) cols.push(c);
        if (this.sweepMode === 'zigzag' && rowFromBottom % 2 === 1) {
          cols.reverse();
        }

        // Move player carriage to start of line
        if (this.movePlayer) {
          const startP = this._playerCoords(cols[0], rowFromBottom);
          movePlayer(startP.x, startP.y, startP.z);
          await this._sleep(100);
        }

        this.progress.row = currentLineNum;
        this.progress.status = `Printing row ${currentLineNum}/${this.h}...`;
        this._notify();

        // 1. Sweep across the line placing blocks
        for (const col of cols) {
          await this._waitUnpaused();
          if (this._cancel) return;

          const woolIdx = this.grid[imgRow][col];
          if (woolIdx < 0) continue; // transparent = skip

          const blockId = this.blockIds[woolIdx];
          if (blockId == null || blockId < 0) continue;

          const bPos = this._blockCoords(col, rowFromBottom);

          // Move player carriage with printer
          if (this.movePlayer) {
            const pPos = this._playerCoords(col, rowFromBottom);
            movePlayer(pPos.x, pPos.y, pPos.z);
          }

          const placedOk = placeBlock(bPos.x, bPos.y, bPos.z, blockId);
          if (!placedOk) {
            // Abort if socket transmission failed
            return;
          }

          this.progress.placed++;
          this.progress.col = col;
          this._notify();

          await this._sleep(this.delayMs);
        }

        // 2. Line verification & retry BEFORE moving to next line
        for (let retry = 1; retry <= this.lineRetries && !this._cancel; retry++) {
          await this._sleep(120);

          const missingCols = [];
          for (let col = 0; col < this.w; col++) {
            const woolIdx = this.grid[imgRow][col];
            if (woolIdx < 0) continue;
            const blockId = this.blockIds[woolIdx];
            const bPos = this._blockCoords(col, rowFromBottom);
            if (getBlock(bPos.x, bPos.y, bPos.z) !== blockId) {
              missingCols.push(col);
            }
          }

          if (missingCols.length === 0) {
            break;
          }

          this.progress.status = `Row ${currentLineNum}: fixing ${missingCols.length} missed blocks (pass ${retry})...`;
          this._notify();

          for (const col of missingCols) {
            await this._waitUnpaused();
            if (this._cancel) return;

            const woolIdx = this.grid[imgRow][col];
            const blockId = this.blockIds[woolIdx];
            const bPos = this._blockCoords(col, rowFromBottom);

            if (this.movePlayer) {
              const pPos = this._playerCoords(col, rowFromBottom);
              movePlayer(pPos.x, pPos.y, pPos.z);
            }

            placeBlock(bPos.x, bPos.y, bPos.z, blockId);
            await this._sleep(this.delayMs);
          }
        }

        await this._sleep(60);
      }
    }
  }

  /* ─────────────────────────────────────────────
   * 6. USER INTERFACE (Floating HUD)
   * ───────────────────────────────────────────── */
  function updateStatusUI() {
    const statusDot = document.getElementById('pa-conn-dot');
    const statusText = document.getElementById('pa-conn-text');
    const lockBadge = document.getElementById('pa-lock-badge');
    const startBtn = document.getElementById('pa-start-btn');

    if (!statusDot || !statusText) return;

    if (capturedWS && capturedWS.readyState === 1) {
      statusDot.style.background = '#22c55e';
      statusText.innerHTML = `Live Connected (${packetsSentCount} packets sent)`;
      if (startBtn && activePrinter && !activePrinter.running && document.getElementById('pa-preview-wrap')?.classList.contains('visible')) {
        startBtn.disabled = false;
      }
    } else {
      statusDot.style.background = '#ef4444';
      statusText.textContent = 'Waiting for game WebSocket...';
      if (startBtn && (!activePrinter || !activePrinter.running)) {
        startBtn.disabled = true;
      }
    }

    if (lockBadge) {
      if (roomInfo.lock === 1) {
        lockBadge.style.display = 'inline-block';
        if (playerInfo.verified) {
          lockBadge.style.background = 'rgba(34, 197, 94, 0.2)';
          lockBadge.style.color = '#86efac';
          lockBadge.textContent = `Verified (@${playerInfo.handle || playerInfo.name})`;
        } else {
          lockBadge.style.background = 'rgba(239, 68, 68, 0.25)';
          lockBadge.style.color = '#fca5a5';
          lockBadge.textContent = 'Locked: Verified Only (Press V)';
        }
      } else if (roomInfo.lock === 2) {
        lockBadge.style.display = 'inline-block';
        lockBadge.style.background = 'rgba(239, 68, 68, 0.25)';
        lockBadge.style.color = '#fca5a5';
        lockBadge.textContent = 'Locked: Owner Only';
      } else {
        lockBadge.style.display = 'inline-block';
        lockBadge.style.background = 'rgba(59, 130, 246, 0.2)';
        lockBadge.style.color = '#93c5fd';
        lockBadge.textContent = 'Build: Anyone (Open World)';
      }
    }
  }

  function createUI(printer) {
    activePrinter = printer;

    const existing = document.getElementById('pa-panel');
    if (existing) existing.remove();

    const panel = document.createElement('div');
    panel.id = 'pa-panel';
    panel.innerHTML = `
      <style>
        #pa-panel {
          position: fixed;
          top: 16px;
          right: 16px;
          width: 350px;
          background: rgba(13, 14, 22, 0.94);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 16px;
          color: #f0f0f5;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px;
          z-index: 999999;
          box-shadow: 0 16px 40px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
          overflow: hidden;
          user-select: none;
        }
        #pa-panel * { box-sizing: border-box; }

        #pa-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          background: linear-gradient(135deg, rgba(147, 51, 234, 0.22), rgba(59, 130, 246, 0.15));
          cursor: grab;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        #pa-header:active { cursor: grabbing; }
        #pa-header .title {
          font-weight: 700;
          font-size: 14px;
          display: flex;
          align-items: center;
          gap: 8px;
          letter-spacing: 0.2px;
        }
        #pa-header .byline {
          margin-top: 2px;
          font-size: 10px;
          font-weight: 500;
          color: #c084fc;
          opacity: 0.85;
          letter-spacing: 0.3px;
        }

        #pa-conn-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: rgba(255,255,255,0.7);
          padding: 6px 16px;
          background: rgba(0,0,0,0.25);
          border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        #pa-conn-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #ef4444;
          transition: background 0.3s;
        }
        #pa-lock-badge {
          margin-left: auto;
          font-size: 10px;
          padding: 2px 7px;
          border-radius: 6px;
          font-weight: 600;
        }

        #pa-toggle-btn {
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #bbb;
          border-radius: 6px;
          padding: 3px 8px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.15s;
        }
        #pa-toggle-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }

        #pa-body {
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: 82vh;
          overflow-y: auto;
        }
        #pa-body.collapsed { display: none; }

        .pa-section {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 12px;
          padding: 12px;
        }
        .pa-section h3 {
          margin: 0 0 10px 0;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.8px;
          color: rgba(255, 255, 255, 0.5);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        #pa-dropzone {
          border: 2px dashed rgba(168, 85, 247, 0.4);
          border-radius: 10px;
          padding: 22px 14px;
          text-align: center;
          color: rgba(255, 255, 255, 0.5);
          transition: all 0.2s;
          cursor: pointer;
        }
        #pa-dropzone:hover, #pa-dropzone.dragover {
          border-color: rgba(168, 85, 247, 0.8);
          background: rgba(168, 85, 247, 0.08);
          color: #fff;
        }
        #pa-dropzone input { display: none; }
        #pa-dropzone .icon { font-size: 30px; margin-bottom: 6px; }

        #pa-preview-wrap {
          display: none;
          flex-direction: column;
          align-items: center;
          gap: 8px;
        }
        #pa-preview-wrap.visible { display: flex; }
        #pa-preview {
          image-rendering: pixelated;
          border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
          cursor: pointer;
        }
        #pa-preview-info {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.55);
        }

        .pa-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
        .pa-row:last-child { margin-bottom: 0; }
        .pa-row label {
          font-size: 12px;
          color: rgba(255, 255, 255, 0.65);
          min-width: 90px;
        }
        .pa-row input[type="number"], .pa-row select {
          flex: 1;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 6px;
          color: #fff;
          padding: 6px 8px;
          font-size: 12px;
          outline: none;
          transition: border-color 0.15s;
        }
        .pa-row input:focus, .pa-row select:focus {
          border-color: rgba(168, 85, 247, 0.6);
        }
        .pa-row input[type="checkbox"] {
          accent-color: #a855f7;
          width: 16px;
          height: 16px;
          cursor: pointer;
        }
        .pa-note {
          font-size: 10px;
          color: #fbbf24;
          line-height: 1.35;
          margin: -4px 0 8px;
          padding-left: 90px;
        }

        .pa-coord-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 8px; }
        .pa-coord-row label { font-size: 11px; color: rgba(255, 255, 255, 0.45); text-align: center; display: block; margin-bottom: 3px; }
        .pa-coord-row input {
          width: 100%;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 6px;
          color: #fff;
          padding: 6px;
          font-size: 12px;
          text-align: center;
          font-family: monospace;
          outline: none;
        }
        .pa-coord-row input:focus { border-color: rgba(168, 85, 247, 0.6); }

        .pa-btn-secondary {
          background: rgba(59, 130, 246, 0.15);
          border: 1px solid rgba(59, 130, 246, 0.3);
          color: #93c5fd;
          border-radius: 6px;
          padding: 7px 10px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 500;
          transition: all 0.15s;
          width: 100%;
        }
        .pa-btn-secondary:hover { background: rgba(59, 130, 246, 0.28); color: #bfdbfe; }

        #pa-controls { display: flex; gap: 8px; }
        .pa-btn {
          flex: 1;
          padding: 10px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
          transition: all 0.15s;
        }
        #pa-start-btn {
          background: linear-gradient(135deg, #a855f7, #6366f1);
          color: #fff;
          box-shadow: 0 4px 14px rgba(168, 85, 247, 0.35);
        }
        #pa-start-btn:hover { filter: brightness(1.15); }
        #pa-start-btn:disabled { opacity: 0.35; cursor: not-allowed; box-shadow: none; filter: none; }

        #pa-pause-btn {
          background: rgba(234, 179, 8, 0.15);
          color: #facc15;
          border: 1px solid rgba(234, 179, 8, 0.3);
        }
        #pa-pause-btn:hover { background: rgba(234, 179, 8, 0.25); }

        #pa-stop-btn {
          background: rgba(239, 68, 68, 0.15);
          color: #f87171;
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        #pa-stop-btn:hover { background: rgba(239, 68, 68, 0.25); }

        #pa-clear-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #bbb;
          border-radius: 6px;
          padding: 7px;
          font-size: 11px;
          cursor: pointer;
          width: 100%;
          margin-top: 6px;
        }
        #pa-clear-btn:hover { background: rgba(239, 68, 68, 0.2); color: #f87171; border-color: rgba(239, 68, 68, 0.4); }

        #pa-progress-section { display: none; }
        #pa-progress-section.visible { display: block; }
        #pa-progress-bar-outer {
          width: 100%;
          height: 8px;
          background: rgba(255, 255, 255, 0.08);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 8px;
        }
        #pa-progress-bar {
          height: 100%;
          width: 0%;
          background: linear-gradient(90deg, #a855f7, #3b82f6);
          border-radius: 4px;
          transition: width 0.2s ease;
        }
        #pa-status {
          font-size: 11px;
          color: rgba(255, 255, 255, 0.65);
          line-height: 1.4;
        }
        #pa-status strong { color: #fff; }

        #pa-tabs {
          display: flex;
          gap: 4px;
          padding: 6px 10px 0 10px;
          background: rgba(0,0,0,0.25);
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .pa-tab {
          flex: 1;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: rgba(255,255,255,0.55);
          padding: 7px 6px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s;
        }
        .pa-tab:hover { color: #fff; }
        .pa-tab.active {
          color: #fff;
          border-bottom-color: #a855f7;
        }
        #pa-gallery-count {
          display: inline-block;
          min-width: 16px;
          padding: 0 5px;
          margin-left: 2px;
          font-size: 10px;
          border-radius: 9px;
          background: rgba(168, 85, 247, 0.3);
          color: #e9d5ff;
        }
        .pa-tabpane { display: flex; flex-direction: column; gap: 12px; }

        #pa-gallery-empty {
          font-size: 11px;
          color: rgba(255,255,255,0.45);
          line-height: 1.5;
          padding: 6px 2px;
        }
        #pa-gallery-list { display: flex; flex-direction: column; gap: 8px; }
        .pa-art {
          display: flex;
          gap: 10px;
          align-items: center;
          background: rgba(0,0,0,0.25);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px;
          padding: 8px;
        }
        .pa-art-thumb {
          width: 54px;
          height: 54px;
          object-fit: contain;
          image-rendering: pixelated;
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          flex-shrink: 0;
        }
        .pa-art-info { flex: 1; min-width: 0; }
        .pa-art-name {
          font-size: 12px;
          font-weight: 700;
          color: #fff;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          cursor: text;
        }
        .pa-art-meta {
          font-size: 10px;
          color: rgba(255,255,255,0.5);
          font-family: monospace;
          margin-top: 2px;
        }
        .pa-art-btns { display: flex; gap: 4px; flex-shrink: 0; }
        .pa-art-btn {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.06);
          color: #ddd;
          cursor: pointer;
          font-size: 13px;
          line-height: 1;
          transition: all 0.15s;
        }
        .pa-art-btn.redo:hover { background: rgba(59,130,246,0.3); color: #bfdbfe; }
        .pa-art-btn.clean:hover { background: rgba(234,179,8,0.3); color: #fde68a; }
        .pa-art-btn.del:hover { background: rgba(239,68,68,0.3); color: #fca5a5; }
        #pa-gallery-clearall { margin-top: 2px; }
      </style>

      <div id="pa-header">
        <div class="title-wrap">
          <div class="title"><span>🖨️</span> Pixel Art Printer <span style="font-size:10px; color:#c084fc; background:rgba(147,51,234,0.3); padding:2px 6px; border-radius:10px;">v1.6.7</span></div>
          <div class="byline">by @vibecodingonsol</div>
        </div>
        <button id="pa-toggle-btn">▾</button>
      </div>

      <div id="pa-conn-status">
        <div id="pa-conn-dot"></div>
        <span id="pa-conn-text">Waiting for game WebSocket...</span>
        <span id="pa-lock-badge" style="display:none;"></span>
      </div>

      <div id="pa-tabs">
        <button class="pa-tab active" data-tab="printer">🖨️ Printer</button>
        <button class="pa-tab" data-tab="gallery">🖼️ Gallery <span id="pa-gallery-count">0</span></button>
      </div>

      <div id="pa-body">
        <div id="pa-tab-printer" class="pa-tabpane">
        <!-- Image Upload -->
        <div class="pa-section">
          <h3><span>📷 Image</span> <span style="font-weight:normal; font-size:10px; color:#a855f7;">16 Wool Colors</span></h3>
          <div id="pa-dropzone">
            <div class="icon">🖼️</div>
            <div>Drop image here or <strong>browse</strong></div>
            <input type="file" id="pa-file" accept="image/*">
          </div>
          <div id="pa-preview-wrap">
            <canvas id="pa-preview" title="Click to pick a different image"></canvas>
            <div id="pa-preview-info"></div>
          </div>
        </div>

        <!-- Printer Settings -->
        <div class="pa-section">
          <h3>⚙️ Printer Settings</h3>
          <div class="pa-row">
            <label>Max Width</label>
            <input type="number" id="pa-maxw" value="32" min="1" max="256" step="1">
          </div>
          <div class="pa-row">
            <label>Max Height</label>
            <input type="number" id="pa-maxh" value="32" min="1" max="128" step="1">
          </div>
          <div class="pa-row">
            <label>Delay (ms)</label>
            <input type="number" id="pa-delay" value="180" min="10" max="2000" step="5" title="180 ms is tested working — lower values may cause the server to drop blocks">
          </div>
          <div class="pa-note">⚠️ 180 ms is tested working. Lower values may cause the server to silently drop blocks (results vary with server load).</div>
          <div class="pa-row">
            <label>Line Retries</label>
            <input type="number" id="pa-retries" value="30" min="1" max="60" step="1" title="Sweeps to fix missed/leftover blocks before moving to the next line (used for both building and cleaning)">
          </div>
          <div class="pa-row">
            <label>Facing / Wall</label>
            <select id="pa-dir">
              <option value="north">North (+X wall, facing South)</option>
              <option value="south">South (-X wall, facing North)</option>
              <option value="east">East (+Z wall, facing West)</option>
              <option value="west">West (-Z wall, facing East)</option>
              <option value="floor">Floor (Horizontal flat art)</option>
            </select>
          </div>
          <div class="pa-row">
            <label>Carriage Mode</label>
            <select id="pa-mode">
              <option value="ltr">Left → Right (Printer sweep)</option>
              <option value="zigzag" selected>Zig-zag (Bidirectional)</option>
            </select>
          </div>
          <div class="pa-row">
            <label>Move Player</label>
            <input type="checkbox" id="pa-move-player" checked title="Player moves like the printer carriage">
            <span style="font-size:11px; color:rgba(255,255,255,0.45); margin-left:6px;">Follow printer carriage</span>
          </div>
          <div class="pa-row">
            <label>Dithering</label>
            <input type="checkbox" id="pa-dither" checked title="Floyd-Steinberg error diffusion for smoother gradients">
            <span style="font-size:11px; color:rgba(255,255,255,0.45); margin-left:6px;">Floyd-Steinberg (smoother)</span>
          </div>
          <div class="pa-row">
            <label>All Blocks</label>
            <input type="checkbox" id="pa-allblocks" title="Use every solid block in the game as a palette color (loads block textures once and caches them)">
            <span id="pa-allblocks-info" style="font-size:11px; color:rgba(255,255,255,0.45); margin-left:6px;">Use all ~70 blocks</span>
          </div>
        </div>

        <!-- Origin Coordinates -->
        <div class="pa-section">
          <h3>📍 Origin (Bottom-Left Corner)</h3>
          <div class="pa-coord-row">
            <div><label>X</label><input type="number" id="pa-ox" value="0"></div>
            <div><label>Y</label><input type="number" id="pa-oy" value="64"></div>
            <div><label>Z</label><input type="number" id="pa-oz" value="0"></div>
          </div>
          <button id="pa-get-pos" class="pa-btn-secondary">📌 Use My Current Position</button>
        </div>

        <!-- Action Controls -->
        <div id="pa-controls">
          <button id="pa-start-btn" class="pa-btn" disabled>▶ Start Printing</button>
          <button id="pa-pause-btn" class="pa-btn" style="display:none;">⏸ Pause</button>
          <button id="pa-stop-btn" class="pa-btn" style="display:none;">⏹ Stop</button>
        </div>

        <button id="pa-clear-btn">🧹 Clear Wall Area (Fill with Air)</button>

        <!-- Progress Feedback -->
        <div id="pa-progress-section" class="pa-section">
          <h3>📊 Progress</h3>
          <div id="pa-progress-bar-outer"><div id="pa-progress-bar"></div></div>
          <div id="pa-status"></div>
        </div>
        </div><!-- /#pa-tab-printer -->

        <div id="pa-tab-gallery" class="pa-tabpane" style="display:none;">
          <div class="pa-section">
            <h3><span>🖼️ Built Artworks</span>
              <span style="font-weight:normal; font-size:10px; color:#a855f7;">saved in this browser</span>
            </h3>
            <div id="pa-gallery-empty">
              No saved artworks yet. Print an image and it will appear here with its
              coordinates and facing, so you can rebuild or quickly clean it.
            </div>
            <div id="pa-gallery-list"></div>
          </div>
          <button id="pa-gallery-clearall" class="pa-btn-secondary">🗑️ Forget all saved artworks</button>
        </div><!-- /#pa-tab-gallery -->
      </div>
    `;

    document.body.appendChild(panel);

    // ── Drag & move panel ──
    const header = panel.querySelector('#pa-header');
    let dragOff = { x: 0, y: 0 };
    header.addEventListener('mousedown', (e) => {
      if (e.target.id === 'pa-toggle-btn') return;
      e.preventDefault();
      dragOff = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
      const onMove = (ev) => {
        panel.style.left = Math.max(0, ev.clientX - dragOff.x) + 'px';
        panel.style.top = Math.max(0, ev.clientY - dragOff.y) + 'px';
        panel.style.right = 'auto';
      };
      const onUp = () => {
        removeEventListener('mousemove', onMove);
        removeEventListener('mouseup', onUp);
      };
      addEventListener('mousemove', onMove);
      addEventListener('mouseup', onUp);
    });

    // ── Collapse panel ──
    const toggleBtn = panel.querySelector('#pa-toggle-btn');
    const body = panel.querySelector('#pa-body');
    toggleBtn.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      toggleBtn.textContent = body.classList.contains('collapsed') ? '▸' : '▾';
    });

    // ── Image Handling ──
    const dropzone = panel.querySelector('#pa-dropzone');
    const fileInput = panel.querySelector('#pa-file');
    const previewWrap = panel.querySelector('#pa-preview-wrap');
    const previewCanvas = panel.querySelector('#pa-preview');
    const previewInfo = panel.querySelector('#pa-preview-info');
    const startBtn = panel.querySelector('#pa-start-btn');
    const ditherCheck = panel.querySelector('#pa-dither');
    const allBlocksCheck = panel.querySelector('#pa-allblocks');
    const allBlocksInfo = panel.querySelector('#pa-allblocks-info');
    const maxWInput = panel.querySelector('#pa-maxw');
    const maxHInput = panel.querySelector('#pa-maxh');

    let loadedImage = null;
    let currentGrid = null, currentW = 0, currentH = 0;
    let convertToken = 0;

    // Resolve which palette is currently selected, loading the all-blocks
    // palette on demand and returning null if the user cancelled/failed.
    const resolvePalette = async () => {
      if (!allBlocksCheck.checked) {
        allBlocksInfo.textContent = 'Use all ~70 blocks';
        return { rgb: WOOL_RGB, ids: woolBlockIds.slice(), all: false };
      }
      if (fullPalette) return fullPalette;
      allBlocksInfo.textContent = 'Loading block palette… 0%';
      try {
        const pal = await buildFullPalette((done, total) => {
          allBlocksInfo.textContent = `Loading block palette… ${Math.round((done / total) * 100)}%`;
        });
        allBlocksInfo.textContent = `Using ${pal.rgb.length} blocks ✨`;
        return pal;
      } catch (e) {
        allBlocksCheck.checked = false;
        allBlocksInfo.textContent = 'Use all ~70 blocks';
        alert('Could not load the all-blocks palette:\n' + e.message + '\n\nFalling back to the 16 wool colors.');
        return { rgb: WOOL_RGB, ids: woolBlockIds.slice(), all: false };
      }
    };

    const updateConversion = async () => {
      if (!loadedImage) return;
      const token = ++convertToken;

      const maxW = parseInt(maxWInput.value) || 32;
      const maxH = parseInt(maxHInput.value) || 32;
      const dither = ditherCheck.checked;

      const pal = await resolvePalette();
      if (token !== convertToken) return; // a newer conversion superseded this one
      activePalette = pal;

      const { grid, w, h } = imageToGrid(loadedImage, maxW, maxH, dither);
      currentGrid = grid;
      currentW = w;
      currentH = h;
      drawPreview(previewCanvas, grid, w, h, pal);
      const blocks = grid.flat().filter((v) => v >= 0).length;
      previewInfo.textContent = `${w}×${h} blocks (${blocks} blocks, ${pal.rgb.length} colors)`;
      previewWrap.classList.add('visible');
      dropzone.style.display = 'none';
      if (capturedWS && capturedWS.readyState === 1) {
        startBtn.disabled = false;
      }
    };

    const processFile = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          loadedImage = img;
          updateConversion();
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    };

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) processFile(fileInput.files[0]);
    });
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) processFile(e.dataTransfer.files[0]);
    });

    previewCanvas.addEventListener('click', () => fileInput.click());

    maxWInput.addEventListener('change', updateConversion);
    maxHInput.addEventListener('change', updateConversion);
    ditherCheck.addEventListener('change', updateConversion);
    allBlocksCheck.addEventListener('change', updateConversion);

    // ── Get player coordinates ──
    panel.querySelector('#pa-get-pos').addEventListener('click', () => {
      const pos = getPlayerPos();
      if (!pos) {
        alert('Could not detect position yet. Make sure you are spawned in the world.');
        return;
      }
      panel.querySelector('#pa-ox').value = Math.floor(pos.x);
      panel.querySelector('#pa-oy').value = Math.floor(pos.y);
      panel.querySelector('#pa-oz').value = Math.floor(pos.z);
    });

    // ── Controls & Progress ──
    const pauseBtn = panel.querySelector('#pa-pause-btn');
    const stopBtn = panel.querySelector('#pa-stop-btn');
    const clearBtn = panel.querySelector('#pa-clear-btn');
    const progressSection = panel.querySelector('#pa-progress-section');
    const progressBar = panel.querySelector('#pa-progress-bar');
    const statusEl = panel.querySelector('#pa-status');

    printer.onProgress = (p) => {
      progressSection.classList.add('visible');
      const pct = p.total > 0 ? Math.min(100, Math.round((p.placed / p.total) * 100)) : 0;
      progressBar.style.width = pct + '%';
      statusEl.innerHTML = `<strong>${p.status}</strong><br>${p.placed}/${p.total} blocks (${pct}%) — ${packetsSentCount} sent`;
    };

    const getOrigin = () => ({
      x: parseInt(panel.querySelector('#pa-ox').value) || 0,
      y: parseInt(panel.querySelector('#pa-oy').value) || 64,
      z: parseInt(panel.querySelector('#pa-oz').value) || 0,
    });

    // ── Artwork gallery storage (persisted in this browser) ──
    const ART_KEY = 'tcpixelart.artworks.v1';
    const loadArtworks = () => {
      try {
        const r = JSON.parse(localStorage.getItem(ART_KEY));
        return Array.isArray(r) ? r : [];
      } catch (e) { return []; }
    };
    const persistArtworks = (list) => {
      try { localStorage.setItem(ART_KEY, JSON.stringify(list)); }
      catch (e) { console.warn('[PixelArt] Could not save artworks:', e); }
    };
    const encodeGrid = (grid) => {
      let s = '';
      for (const row of grid) for (const v of row) s += String.fromCharCode(v + 1);
      return btoa(s);
    };
    const decodeGrid = (b64, w, h) => {
      const s = atob(b64);
      const grid = [];
      for (let y = 0; y < h; y++) {
        const row = [];
        for (let x = 0; x < w; x++) row.push(s.charCodeAt(y * w + x) - 1);
        grid.push(row);
      }
      return grid;
    };
    const gridThumbnail = (grid, w, h, pal) => {
      const palette = (pal && pal.rgb) || WOOL_RGB;
      const scale = Math.max(1, Math.floor(96 / Math.max(w, h)));
      const c = document.createElement('canvas');
      c.width = w * scale;
      c.height = h * scale;
      const ctx = c.getContext('2d');
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const v = grid[y][x];
          if (v < 0) ctx.fillStyle = (x + y) % 2 ? '#1a1a1a' : '#252525';
          else { const [r, g, b] = palette[v]; ctx.fillStyle = `rgb(${r},${g},${b})`; }
          ctx.fillRect(x * scale, y * scale, scale, scale);
        }
      }
      return c.toDataURL('image/png');
    };

    let artworks = loadArtworks();

    const galleryList = panel.querySelector('#pa-gallery-list');
    const galleryEmpty = panel.querySelector('#pa-gallery-empty');
    const galleryCount = panel.querySelector('#pa-gallery-count');

    const dirLabel = (d) => ({
      north: 'North (+X wall)', south: 'South (-X wall)', east: 'East (+Z wall)',
      west: 'West (-Z wall)', floor: 'Floor',
    }[d] || d);

    const switchTab = (name) => {
      panel.querySelectorAll('.pa-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
      panel.querySelector('#pa-tab-printer').style.display = name === 'printer' ? '' : 'none';
      panel.querySelector('#pa-tab-gallery').style.display = name === 'gallery' ? '' : 'none';
    };

    const renderGallery = () => {
      galleryCount.textContent = String(artworks.length);
      galleryList.innerHTML = '';
      galleryEmpty.style.display = artworks.length ? 'none' : 'block';

      for (const art of artworks) {
        const el = document.createElement('div');
        el.className = 'pa-art';

        const img = document.createElement('img');
        img.className = 'pa-art-thumb';
        img.src = art.preview || '';
        img.alt = art.name || 'artwork';

        const info = document.createElement('div');
        info.className = 'pa-art-info';
        const name = document.createElement('div');
        name.className = 'pa-art-name';
        name.textContent = art.name || 'Untitled';
        name.title = 'Click to rename';
        const meta = document.createElement('div');
        meta.className = 'pa-art-meta';
        meta.textContent = `${art.w}×${art.h} · ${dirLabel(art.direction)} · (${art.origin.x}, ${art.origin.y}, ${art.origin.z})`;
        info.appendChild(name);
        info.appendChild(meta);

        const btns = document.createElement('div');
        btns.className = 'pa-art-btns';
        const bRedo = document.createElement('button');
        bRedo.className = 'pa-art-btn redo'; bRedo.textContent = '🔁'; bRedo.title = 'Rebuild this artwork';
        const bClean = document.createElement('button');
        bClean.className = 'pa-art-btn clean'; bClean.textContent = '🧹'; bClean.title = 'Quick-clean this artwork';
        const bDel = document.createElement('button');
        bDel.className = 'pa-art-btn del'; bDel.textContent = '🗑️'; bDel.title = 'Remove from list';
        btns.appendChild(bRedo); btns.appendChild(bClean); btns.appendChild(bDel);

        name.addEventListener('click', () => {
          const nn = prompt('Artwork name:', art.name || 'Untitled');
          if (nn != null) { art.name = nn.trim() || art.name; persistArtworks(artworks); renderGallery(); }
        });
        bRedo.addEventListener('click', () => redoArtwork(art));
        bClean.addEventListener('click', () => cleanArtwork(art));
        bDel.addEventListener('click', () => {
          if (!confirm(`Remove "${art.name}" from the list? (world blocks are not affected)`)) return;
          artworks = artworks.filter((a) => a.id !== art.id);
          persistArtworks(artworks);
          renderGallery();
        });

        el.appendChild(img);
        el.appendChild(info);
        el.appendChild(btns);
        galleryList.appendChild(el);
      }
    };

    const runPrint = async (redoId) => {
      if (!currentGrid || printer.running) return;
      if (!capturedWS || capturedWS.readyState !== 1) {
        alert('⚠️ Cannot start printing: Game WebSocket is not captured yet!\n\nPlease wait a few seconds for the world to fully load, or walk a couple steps in-game.');
        return;
      }

      discoverWoolIds();

      const dbgMc = targetWindow.__mc || window.__mc;
      console.log('[PIXEL-DEBUG] PRINT START — roomMode=', roomInfo.mode,
        '| S.sv=', !!(dbgMc && dbgMc.S && dbgMc.S.sv),
        '| survivalClient=', !!(dbgMc && dbgMc.survival),
        '| net.place=', !!(dbgMc && dbgMc.net && dbgMc.net.place),
        '| S.hotbar=', dbgMc && dbgMc.S ? JSON.stringify(dbgMc.S.hotbar) : 'n/a');

      const origin = getOrigin();
      const dir = panel.querySelector('#pa-dir').value;
      const delay = parseInt(panel.querySelector('#pa-delay').value) || 180;
      const retries = parseInt(panel.querySelector('#pa-retries').value) || 30;
      const mode = panel.querySelector('#pa-mode').value;
      const movePlayerOpt = panel.querySelector('#pa-move-player').checked;
      const pal = activePalette;

      // Height check: walls grow upward from origin.y, floors stay at origin.y.
      // The topmost block must stay below y = 128 (max valid y is 127).
      const topY = dir === 'floor' ? origin.y : origin.y + currentH - 1;
      if (topY >= 128) {
        alert(
          `⚠️ Cannot start printing: the artwork would exceed the world height limit.\n\n` +
          `Origin Y: ${origin.y}\n` +
          `Image height: ${currentH}\n` +
          `Top block Y: ${topY} (max allowed: 127)\n\n` +
          `Lower the origin Y or reduce the image height so it fits below Y=128.`
        );
        return;
      }

      startBtn.style.display = 'none';
      pauseBtn.style.display = '';
      stopBtn.style.display = '';

      await printer.start(currentGrid, currentW, currentH, origin, dir, delay, retries, mode, movePlayerOpt, pal.ids);

      startBtn.style.display = '';
      pauseBtn.style.display = 'none';
      stopBtn.style.display = 'none';

      if (!printer._cancel) {
        recordArtwork(redoId || null, currentGrid, currentW, currentH, origin, dir, delay, retries, mode, movePlayerOpt, pal);
      }
    };

    const runClearAt = async (w, h, origin, dir, delay, retries, followPlayer) => {
      if (printer.running) return;
      startBtn.style.display = 'none';
      stopBtn.style.display = '';
      await printer.clearArea(w, h, origin, dir, delay, retries, followPlayer);
      startBtn.style.display = '';
      stopBtn.style.display = 'none';
    };

    const recordArtwork = (id, grid, w, h, origin, direction, delay, retries, mode, movePlayerOpt, pal) => {
      const palette = (pal && pal.rgb) ? pal : activePalette;
      const preview = gridThumbnail(grid, w, h, palette);
      const packed = encodeGrid(grid);
      const paletteRec = { rgb: palette.rgb, ids: palette.ids, all: !!palette.all };
      const existing = id ? artworks.find((a) => a.id === id) : null;
      if (existing) {
        existing.preview = preview;
        existing.grid = packed;
        existing.palette = paletteRec;
        existing.ts = Date.now();
        existing.w = w; existing.h = h;
        existing.origin = origin; existing.direction = direction;
        existing.delayMs = delay; existing.retries = retries;
        existing.sweepMode = mode; existing.movePlayer = movePlayerOpt;
      } else {
        artworks.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          name: `Artwork ${artworks.length + 1}`,
          ts: Date.now(), w, h, origin, direction,
          delayMs: delay, retries, sweepMode: mode, movePlayer: movePlayerOpt,
          preview, grid: packed, palette: paletteRec,
        });
      }
      if (artworks.length > 100) artworks = artworks.slice(0, 100);
      persistArtworks(artworks);
      renderGallery();
    };

    const redoArtwork = async (art) => {
      if (printer.running) { alert('Printer is busy. Stop the current job first.'); return; }
      if (!confirm(`Rebuild "${art.name}" (${art.w}×${art.h}) at (${art.origin.x}, ${art.origin.y}, ${art.origin.z}) facing ${dirLabel(art.direction)}?`)) return;

      const pal = sanitizePalette((art.palette && art.palette.rgb && art.palette.ids)
        ? art.palette
        : { rgb: WOOL_RGB, ids: woolBlockIds.slice(), all: false });
      activePalette = pal;
      allBlocksCheck.checked = !!pal.all;
      allBlocksInfo.textContent = pal.all ? `Using ${pal.rgb.length} blocks ✨` : 'Use all ~70 blocks';
      if (pal.all && !fullPalette) {
        try { fullPalette = await buildFullPalette(); } catch (e) { /* use stored palette anyway */ }
      }

      currentGrid = decodeGrid(art.grid, art.w, art.h);
      currentW = art.w;
      currentH = art.h;
      loadedImage = null;

      drawPreview(previewCanvas, currentGrid, currentW, currentH, pal);
      const blocks = currentGrid.flat().filter((v) => v >= 0).length;
      previewInfo.textContent = `${currentW}×${currentH} blocks (${blocks} blocks, ${pal.rgb.length} colors)`;
      previewWrap.classList.add('visible');
      dropzone.style.display = 'none';

      panel.querySelector('#pa-ox').value = art.origin.x;
      panel.querySelector('#pa-oy').value = art.origin.y;
      panel.querySelector('#pa-oz').value = art.origin.z;
      panel.querySelector('#pa-dir').value = art.direction || 'north';
      panel.querySelector('#pa-mode').value = art.sweepMode || 'ltr';
      panel.querySelector('#pa-move-player').checked = art.movePlayer !== false;
      if (art.delayMs) panel.querySelector('#pa-delay').value = art.delayMs;
      if (art.retries) panel.querySelector('#pa-retries').value = art.retries;

      switchTab('printer');
      runPrint(art.id);
    };

    const cleanArtwork = async (art) => {
      if (printer.running) { alert('Printer is busy. Stop the current job first.'); return; }
      if (!confirm(`Quick-clean "${art.name}" (${art.w}×${art.h}) at (${art.origin.x}, ${art.origin.y}, ${art.origin.z})?`)) return;

      const delay = parseInt(panel.querySelector('#pa-delay').value) || 180;
      const retries = parseInt(panel.querySelector('#pa-retries').value) || 30;
      const followPlayer = panel.querySelector('#pa-move-player').checked;
      switchTab('printer');
      await runClearAt(art.w, art.h, art.origin, art.direction, delay, retries, followPlayer);
    };

    panel.querySelectorAll('.pa-tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    panel.querySelector('#pa-gallery-clearall').addEventListener('click', () => {
      if (!artworks.length) return;
      if (!confirm('Forget all saved artworks? (world blocks are not affected)')) return;
      artworks = [];
      persistArtworks(artworks);
      renderGallery();
    });

    startBtn.addEventListener('click', () => runPrint());

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
      if (!currentW || !currentH) {
        alert('Please load an image first so the dimensions are known.');
        return;
      }
      if (!confirm(`Are you sure you want to clear ${currentW}×${currentH} area with air?`)) return;

      const origin = getOrigin();
      const dir = panel.querySelector('#pa-dir').value;
      const delay = parseInt(panel.querySelector('#pa-delay').value) || 180;
      const retries = parseInt(panel.querySelector('#pa-retries').value) || 30;
      const followPlayer = panel.querySelector('#pa-move-player').checked;

      await runClearAt(currentW, currentH, origin, dir, delay, retries, followPlayer);
    });

    renderGallery();
    updateStatusUI();
    return panel;
  }

  /* ─────────────────────────────────────────────
   * 7. BOOTSTRAP
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
    console.log('[PixelArt] Userscript initialized. Waiting for game to load...');
    await waitForGame();

    await new Promise((r) => setTimeout(r, 1500));

    discoverWoolIds();

    const printer = new PixelPrinter();
    createUI(printer);

    setTimeout(() => {
      const pos = getPlayerPos();
      if (pos) {
        const ox = document.getElementById('pa-ox');
        const oy = document.getElementById('pa-oy');
        const oz = document.getElementById('pa-oz');
        if (ox && oy && oz) {
          ox.value = Math.floor(pos.x);
          oy.value = Math.floor(pos.y);
          oz.value = Math.floor(pos.z);
        }
      }
      updateStatusUI();
    }, 2000);

    console.log('[PixelArt] Pixel Art Printer Ready! Panel opened.');
  }

  main().catch(console.error);
})();
