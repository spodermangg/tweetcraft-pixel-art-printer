# 🎨 TweetCraft Pixel Art Printer

A Tampermonkey userscript that turns any image into high-quality wool pixel art in **TweetCraft** (`tweetcraft.jai.vin`), behaving just like a printer bot: sweeping line by line, moving the player carriage across each row, verifying and replacing missed blocks caused by lag, and stepping up row by row.

---

## ✨ Features

- **🖨️ Printer-Like Sweep**:
  - Sweeps **Left → Right** across each row (or optional bidirectional zig-zag).
  - Automatically moves and hovers your player character along the wall carriage so everyone on the server sees the bot printing.
  - **Per-Line Lag Correction**: Verifies every placed block in the current line and re-places any missing or reverted blocks **before moving to the next line**.
- **🌐 Real Server Multiplayer Sync**:
  - Dual-hook WebSocket engine intercepts outgoing network packets and server responses.
  - Blocks are broadcast in real-time to all connected multiplayer peers and permanently saved in the world database.
  - Live server status badge: shows live connection status, world build permissions, and verification state.
- **🎨 16 Wool Color Mapping + Dithering**:
  - Maps image colors to the 16 Minecraft wool dyes using perceptual color distance (`ΔE`).
  - **Floyd-Steinberg Dithering**: Diffuses color error for smooth gradients and realistic photos even with only 16 palette colors.
- **⚡ Production & Dev Mode Support**:
  - Intercepts WebAssembly and game WebSocket connections at `@run-at document-start` to work in production worlds where `window.__mc` is disabled.
- **📍 Multi-Direction & Floor Support**:
  - Builds vertical walls facing North, South, East, or West.
  - Supports flat horizontal ground/floor pixel art.
  - One-click `"📌 Use My Current Position"` to set the origin corner automatically.
- **🧹 Utility Tools**:
  - Clear/erase area button to easily wipe the canvas and start over.
  - Pause, resume, and stop controls.
- **🖼️ Built Artwork Gallery**:
  - Every successfully printed image is saved locally (name, size, coordinates, facing, and a thumbnail).
  - **🔁 Rebuild** an artwork later to re-print it (handy if a block got griefed or you want a copy elsewhere).
  - **🧹 Quick-clean** an artwork to instantly erase just its footprint, or **🗑️ Delete** it from the list (world is untouched).
  - Rename entries by clicking their title. Switch between the **Printer** and **Gallery** tabs at any time.

---

## 🔒 World Build Permissions (Important)

TweetCraft has 3 types of world locks set by world owners:
1. **Anyone (`lock: 0`)**: Open worlds like [https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6](https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6). Anyone (even guest accounts) can build and their blocks are saved on the server for all players!
2. **Verified Players Only (`lock: 1`)**: Worlds like `fst7ifvgmn7x8k8v`. The server rejects block edits from unverified guests (`"Verify your account in the menu to build in this world"`). Press **V** in-game or open Menu → "Save your progress" to link your 𝕏 account before printing.
3. **Owner Only (`lock: 2`)**: Only the world creator can build.

The printer panel displays a live indicator showing if the world is open or locked, and your current verification status.

---

## 🚀 How to Install & Use

### 1. Install Tampermonkey
Make sure you have [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey) installed in your browser.

### 2. Add the Userscript
1. Open Tampermonkey Dashboard → Click the **"+" (Create new script)** tab.
2. Open [`tweetcraft-pixel-art-printer.user.js`](./tweetcraft-pixel-art-printer.user.js).
3. Copy and paste the entire script into Tampermonkey.
4. Press `Ctrl+S` (or `Cmd+S`) to save.

### 3. Open TweetCraft
1. Go to your TweetCraft world:
   - **Open Build World**: [https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6](https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6)
2. When the game loads, you will see a sleek dark floating panel in the top-right corner: **"🖨️ Pixel Art Printer"**.
3. Check the status indicator: it will show **🟢 Server Connected (Live)** and **Build: Anyone (Open World)**.
4. Drag & drop any image into the box.
5. Click **"📌 Use My Current Position"** to set the bottom-left corner of the wall.
6. Select your wall orientation (North, South, East, West, or Floor).
7. Click **"▶ Start Printing"** and watch the bot print!
8. Open the **🖼️ Gallery** tab to rebuild, quick-clean, rename, or delete any artwork you've printed.
# 🎨 TweetCraft Pixel Art Printer

A Tampermonkey userscript that turns any image into high-quality wool pixel art in **TweetCraft** (`tweetcraft.jai.vin`), behaving just like a printer bot: sweeping line by line, moving the player carriage across each row, verifying and replacing missed blocks caused by lag, and stepping up row by row.

---

## ✨ Features

- **🖨️ Printer-Like Sweep**:
  - Sweeps **Left → Right** across each row (or optional bidirectional zig-zag).
  - Automatically moves and hovers your player character along the wall carriage so everyone on the server sees the bot printing.
  - **Per-Line Lag Correction**: Verifies every placed block in the current line and re-places any missing or reverted blocks **before moving to the next line**.
- **🌐 Real Server Multiplayer Sync**:
  - Dual-hook WebSocket engine intercepts outgoing network packets and server responses.
  - Blocks are broadcast in real-time to all connected multiplayer peers and permanently saved in the world database.
  - Live server status badge: shows live connection status, world build permissions, and verification state.
- **🎨 16 Wool Color Mapping + Dithering**:
  - Maps image colors to the 16 Minecraft wool dyes using perceptual color distance (`ΔE`).
  - **Floyd-Steinberg Dithering**: Diffuses color error for smooth gradients and realistic photos even with only 16 palette colors.
- **⚡ Production & Dev Mode Support**:
  - Intercepts WebAssembly and game WebSocket connections at `@run-at document-start` to work in production worlds where `window.__mc` is disabled.
- **📍 Multi-Direction & Floor Support**:
  - Builds vertical walls facing North, South, East, or West.
  - Supports flat horizontal ground/floor pixel art.
  - One-click `"📌 Use My Current Position"` to set the origin corner automatically.
- **🧹 Utility Tools**:
  - Clear/erase area button to easily wipe the canvas and start over.
  - Pause, resume, and stop controls.
- **🖼️ Built Artwork Gallery**:
  - Every successfully printed image is saved locally (name, size, coordinates, facing, and a thumbnail).
  - **🔁 Rebuild** an artwork later to re-print it (handy if a block got griefed or you want a copy elsewhere).
  - **🧹 Quick-clean** an artwork to instantly erase just its footprint, or **🗑️ Delete** it from the list (world is untouched).
  - Rename entries by clicking their title. Switch between the **Printer** and **Gallery** tabs at any time.

---

## 🔒 World Build Permissions (Important)

TweetCraft has 3 types of world locks set by world owners:
1. **Anyone (`lock: 0`)**: Open worlds like [https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6](https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6). Anyone (even guest accounts) can build and their blocks are saved on the server for all players!
2. **Verified Players Only (`lock: 1`)**: Worlds like `fst7ifvgmn7x8k8v`. The server rejects block edits from unverified guests (`"Verify your account in the menu to build in this world"`). Press **V** in-game or open Menu → "Save your progress" to link your 𝕏 account before printing.
3. **Owner Only (`lock: 2`)**: Only the world creator can build.

The printer panel displays a live indicator showing if the world is open or locked, and your current verification status.

---

## 🚀 How to Install & Use

### 1. Install Tampermonkey
Make sure you have [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey) installed in your browser.

### 2. Add the Userscript
1. Open Tampermonkey Dashboard → Click the **"+" (Create new script)** tab.
2. Open [`tweetcraft-pixel-art-printer.user.js`](./tweetcraft-pixel-art-printer.user.js).
3. Copy and paste the entire script into Tampermonkey.
4. Press `Ctrl+S` (or `Cmd+S`) to save.

### 3. Open TweetCraft
1. Go to your TweetCraft world:
   - **Open Build World**: [https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6](https://tweetcraft.jai.vin/r/qjuc3jjgx3a4y5e6)
2. When the game loads, you will see a sleek dark floating panel in the top-right corner: **"🖨️ Pixel Art Printer"**.
3. Check the status indicator: it will show **🟢 Server Connected (Live)** and **Build: Anyone (Open World)**.
4. Drag & drop any image into the box.
5. Click **"📌 Use My Current Position"** to set the bottom-left corner of the wall.
6. Select your wall orientation (North, South, East, West, or Floor).
7. Click **"▶ Start Printing"** and watch the bot print!
8. Open the **🖼️ Gallery** tab to rebuild, quick-clean, rename, or delete any artwork you've printed.
