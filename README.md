**English** · [Русский](README.ru.md) · [Changelog](CHANGELOG.md)

# AF LiveMap

A live map for [Abiotic Factor](https://store.steampowered.com/app/427410/Abiotic_Factor/) that **builds itself while you play**. A UE4SS mod casts lidar rays from the player's camera, the hits accumulate into a point cloud, and a local web server shows the map in your browser — on PC and phone — in real time.

No pre-made maps needed: you just walk around and look, and the map reveals itself. Scanning can optionally be gated behind the in-game **Rat Scanner** item.

```
   Game (UE4SS Lua mod)              Local server (Python)              Browser (PC / phone)
  positions + lidar rays    ──▶     voxel map, waypoints,        ──▶    2D map & 3D point cloud,
  written to JSON files             routes, sync                       markers, routes, notes
```

---

## Features

### 🗺️ Map scanner — point cloud
- Every tick the mod casts dozens of rays from the camera over a sphere (lidar). Wall hits accumulate into a 50 cm voxel grid.
- The map builds itself **from looking around** — no need to walk along every wall, just pan the camera.
- **Purely additive by default:** points are never deleted, so walls never vanish. Optional auto-cleaning of "ghosts" (moving cars/NPCs) can be enabled with the server `--carve` flag.
- The scan **persists between sessions** and is shared across all devices.

### 🧭 Two views
- **2D** — top-down. Point color encodes height relative to the player (your level — bright cyan, above — green, below — blue), so floors and stairs read clearly. Stays readable and smooth at any zoom, even with millions of scanned voxels (chunked storage + per-pixel far view).
- **3D** — a WebGL point cloud with depth cues: distance fog, Eye-Dome Lighting (surfaces behind other surfaces render darker, walls get contours), and a **"Floor ±5 m / Whole map"** toggle — your floor at full brightness, other floors as a faint ghost for context. Markers are clickable, same as in 2D. After 15 s without input the camera slowly orbits the target for extra depth (any input stops it). Mouse on PC, touch on phone.

### 📍 Markers, elevators, carts, portals
- **Markers (waypoints)** — placed at the player's position, with a name. Rename, delete, "show on map", build a route.
- **Elevators** — recorded with one button: stand in the cabin, press "Elevator", ride through the floors, press again. The map detects the stops by height. The elevator zone is excluded from the scan (the moving cabin no longer creates junk), and routes can ride between floors.
- **Carts / rail transport** — the whole path is recorded; in routes it's a "start ↔ end" edge that draws the real rail trajectory.
- **Portals — auto-detected.** Teleport (a big jump or a world change) and a portal is recorded automatically, both entrance and exit; the list shows how many times you traveled through each. Repeat passes confirm it. Death/respawn is not counted as a portal. There are **"no-portal" zones** (covering the whole height of your base) — for a teleport-to-base item, so it doesn't spawn false portals.
- **Click to inspect & jump.** Click any element (or its list row) to select it: it's highlighted, its list row scrolls into view, and for portals/carts the **link between its two ends** is drawn (in 2D and 3D). Click a portal/cart again to **jump the camera to its other end** (cross-world portals switch to the destination world); elevator clicks cycle through its floors.

### 🚶 Routing that accounts for doors
- Automatic pathfinding (A*) over the scanned "floor".
- **Doors are handled automatically:** the server accumulates the cells the player physically walked through and treats them as walkable on top of the scan. A closed door looks like a wall in the scan — but if you've walked through it even once, a route through it will be found. No buttons.
- Elevators and carts are built into the graph — a route picks them automatically when shorter.

### 📝 Notes and multi-platform
- A shared notepad with autosave, synced between PC and phone.
- The server is exposed to the local network — open the map on your phone on the same Wi-Fi and view/edit from there. The UI is touch-friendly.
- Auto-switches to the world the player is in; you can manually view other worlds (their scan and markers).
- **Interface in English or Russian** — auto-detected from your browser, switchable in the top bar.

---

## Installation

Requires: **Windows**, an installed copy of **Abiotic Factor**, **Python 3.10+**.

### 1. UE4SS

Install UE4SS for Abiotic Factor (a build with game-specific configs — [Nexus Mods](https://www.nexusmods.com/abioticfactor/mods/35)). It unpacks into the game folder:

```
<game folder>\AbioticFactor\Binaries\Win64\
```

Your game path varies, e.g. `C:\Games\AbioticFactor\...` or `C:\Program Files (x86)\Steam\steamapps\common\AbioticFactor\...`. After install, a `ue4ss\` folder appears there when the game starts.

### 2. The mod

Copy the **contents** of the `mod/` folder from this repo into `...\Win64\ue4ss\Mods\AFLiveMap\`, so you get:

```
ue4ss\Mods\AFLiveMap\Scripts\main.lua
ue4ss\Mods\AFLiveMap\config.txt
ue4ss\Mods\AFLiveMap\enabled.txt
```

`enabled.txt` enables the mod without editing `mods.txt`. Once the game starts, the mod writes `livemap.json` and `lidar.json` into its folder. A line `[AFLiveMap] Mod loaded...` appears in `UE4SS.log`.

### 3. The server

> The server files do **not** go into the game folder. Keep this downloaded
> folder anywhere (Desktop is fine) — you just run a small Python program from it.
> You need **Python 3.10+** installed ([python.org](https://www.python.org/downloads/),
> tick **"Add Python to PATH"** during setup).

**Easiest — run `start-server.py`** (double-click it, or `python start-server.py`).
It auto-detects your game folder and starts the server. If it can't find the game,
it asks you to paste the path to `livemap.json` once and remembers it.

**Manual (if you prefer the command line):** from this folder run —

```powershell
python server\server.py --data "C:\Games\AbioticFactor\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\livemap.json"
```

**Set `--data` to your own path** — the `livemap.json` inside the mod folder from step 2 (`...\ue4ss\Mods\AFLiveMap\livemap.json`). If the path is wrong, the server clearly prints a "file not found" warning.

Optional flags: `--port 8765`, `--carve` (auto-clean vehicle/NPC ghosts — off by default), `--lang en|ru|auto` (console language).

On startup the server prints two addresses:

```
AF LiveMap (this PC):  http://127.0.0.1:8765
AF LiveMap (phone):    http://192.168.x.x:8765
```

Open the first one on your PC. Launch the game — the status changes to "online: 1 | world: …" and the map starts building. The running version is shown next to the logo in the top bar.

> **Only one server per data folder.** Accidentally starting a second server used to
> silently corrupt the saved scan; now the second instance refuses to start and tells
> you which process already owns the data. Close the old one and start again.

### 4. Phone (optional)

Open the second address (`http://192.168.x.x:8765`) on a phone on the same Wi-Fi. On first launch Windows asks about the firewall — allow it for private networks. If there was no dialog, add a rule (terminal **as administrator**):

```powershell
netsh advfirewall firewall add rule name="AF LiveMap" dir=in action=allow protocol=TCP localport=8765
```

---

## Configuration (config.txt)

The file `ue4ss\Mods\AFLiveMap\config.txt` is a plain `key = value` file, editable in Notepad. Restart the game after editing.

| Key | Default | What it does |
|-----|---------|--------------|
| `require_rat_scanner` | `true` | `true` — the map builds **only while holding the Rat Scanner**. `false` — scanning always works, no item needed. |
| `scanner_item_match` | `ratscanner` | Substring of the held item's class name to identify the scanner (case-insensitive). Change only if detection fails. |
| `log_held_item` | `false` | Diagnostics: prints the held item's name to the UE4SS console. Use it to find the exact `scanner_item_match`. |
| `language` | `auto` | Language of mod log messages: `auto` (follow the game language), `en`, `ru`. |
| `scan_enabled` | `true` | Fully disable lidar (player positions are still written). |
| `scan_rays` | `12` | Rays per tick. More = faster map, higher load. |
| `scan_range_cm` | `6000` | Ray range, cm (6000 = 60 m). |

### Rat Scanner gating

By default the map is scanned **only while the Rat Scanner is in your hands** — this makes mapping part of the gameplay (find the scanner → you can map). To scan always, without the item:

```
require_rat_scanner = false
```

If the map doesn't build with the Rat Scanner in hand, the item's internal name is different. Find it like this:
1. In `config.txt` set `log_held_item = true`, restart the game.
2. Hold the Rat Scanner, open the UE4SS console — there will be a line `Item in hand: ...`.
3. Put a distinctive part of that name into `scanner_item_match`, set `log_held_item = false`, restart.

---

## Sector map images (optional)

The scan map (2D/3D) works **without** any images. The "Maps" button is a separate popup with sector map screenshots from the in-game journal, purely for reference; they are not included in the repo.

To add them: put images (`.webp`/`.png`) into `maps/`, copy `maps/maps.example.json` → `maps/maps.json` and add entries. Sector map screenshots are on the [wiki](https://abioticfactor.wiki.gg/) and in guides.

---

## Testing without the game

You can run the server and web UI without the game running — a simulator writes fake positions and lidar:

```powershell
# terminal 1 — simulator
python tools\fake_player.py --out livemap.json
# terminal 2 — server pointed at that file
python server\server.py --data livemap.json
```

Two fake players walk around and a "room" scan accumulates on the map.

---

## How it works

- **Mod** (`mod/Scripts/main.lua`) — UE4SS Lua. The game thread does only light data gathering (positions + a few traces); file writes and JSON encoding are offloaded to a background thread so FPS never drops. Writes `livemap.json` (positions) and `lidar.json` (points + where the rays were cast from).
- **Server** (`server/server.py`) — Python stdlib, no dependencies. Watches the mod's files, accumulates the voxel map and "walked" cells (optionally carving along rays with `--carve`), serves the web UI and streams updates over SSE. Stores waypoints/elevators/portals/carts/notes in `data/`.
- **Web** (`web/`) — plain JS + Canvas (2D) and WebGL (3D), no build step and no libraries.

Runtime data (`data/`), sector images and the files the mod writes are not committed (see `.gitignore`) — everyone has their own.

## License

MIT — see [LICENSE](LICENSE). Abiotic Factor is property of Deep Field Games; this project is not affiliated with the developers and uses only UE4SS modding.
