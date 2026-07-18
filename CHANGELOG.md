# Changelog

Release checklist: bump `VERSION` in `server/server.py`, add a section here,
rebuild `dist/AF-LiveMap-<version>.zip`, upload to Nexus.

## 0.3.5 — 2026-07-18

- **New `scan_cone_deg` option — map large areas much faster.** The rays are
  spread over the whole sphere, and their angular density is fixed, so the
  gap between hits grows with distance: ~1.1 m at 5 m but ~6.9 m at 30 m.
  That's why a small room fills in quickly while a big hall feels like it
  never finishes (reaching one-voxel spacing at 30 m would need ~45,000
  directions). Setting `scan_cone_deg` to e.g. `60`–`90` fires the same rays
  in a cone in the direction you're **looking** instead: a 60° cone is ~3.9×
  denser, so halls and long corridors map far faster — you map what you look
  at. Default `0` keeps the existing full-sphere behaviour unchanged.
- `maps.example.json` now shows several entries, so the "one `{ }` per sector,
  comma separated" format is obvious, and drops the `worldMatch`/`transform`
  fields left over from the removed calibration system (never read).

## 0.3.4 — 2026-07-17

- **Works behind a reverse proxy at a sub-path.** All the web UI's requests
  (`/api/…`, `/maps/…`, the SSE stream, the trader catalog) were absolute
  from the host root, so serving the map through a proxy at a path like
  `https://host/aflivemap/` broke every reference. They're now relative to
  the page, so a sub-path proxy just works — no editing the `.js`. Behaves
  identically at the root. (Configure the proxy to strip the sub-path prefix,
  the standard setup, e.g. nginx `location /aflivemap/ { proxy_pass
  http://127.0.0.1:8765/; }`.)

## 0.3.3 — 2026-07-11

- **2D zoomed-out view fixed:** at low zoom the map used to collapse into
  coarse 32 m blocks (whole-chunk squares). Now every scanned column is
  plotted as one pixel via ImageData, so the real facility structure —
  corridors, rooms, height coloring — stays readable at any zoom. The
  ImageData path also covers mid-zoom, cutting that rebuild from ~296 ms
  to ~147 ms; incremental delta painting works in this mode too, so the
  3-second scan stutter does not come back.
- **3D marker clicks:** markers in the 3D view are now clickable (they
  carried no type/id before, so clicking did nothing). Click a label or
  its dot to select the element, same as in 2D; cursor turns into a
  pointer on hover, and tapping works on touch. Traders now appear as 3D
  markers too.
- **Idle auto-orbit:** after 15 s without input the 3D camera slowly
  orbits the target (your character when Follow is on), giving the
  parallax needed to read depth in a still frame. Any mouse/touch input
  stops it instantly.

## 0.3.2 — 2026-07-10

- **perf:** eliminated the stutter every 3 s during active scanning:
  - server answers incremental scan/walked polls from an append-only change
    log (O(new cells), ~0.7 ms) instead of iterating all ~1.8M voxels under
    the store lock (~70 ms per poll);
  - saving no longer blocks queries: only a cheap snapshot happens under the
    lock, the 35 MB JSON serialization runs outside it (was a >1 s freeze
    every 30 s);
  - client paints newly scanned columns onto the existing map canvas instead
    of rebuilding the whole visible region on every poll.
- app version is now shown in the top bar and printed by the server at
  startup (`VERSION` in server.py is the single source of truth).

## 0.3.1 — 2026-07-10

- **Data safety:** per-process temp files for all saves, single-instance
  lock on the data folder (a second server refuses to start), server refuses
  to start with an empty store if a large persist file exists but is
  unreadable. Fixes a real data-loss incident caused by two concurrent
  servers overwriting each other's saves.
- **3D readability overhaul** — the static point cloud was an unreadable mess:
  - distance fog (range scales with camera zoom);
  - "Floor ±5 m / Whole map" toggle: your floor at full brightness, other
    floors ghosted at ~12% instead of hidden — building context stays visible;
  - Eye-Dome Lighting post-process: contours and relief like Potree /
    CloudCompare; surfaces behind other surfaces render visibly darker
    (log-encoded depth, sampling rings sized past the point sprites);
  - floor filter moved to the shader — switching floors no longer rebuilds
    the 1.7M-point GPU buffer (~1.2 s stall each time);
  - fixed route/selection lines potentially discarded by the round-point
    fragment check.

## 0.3.0 — 2026-07-10 (published on Nexus 2026-07-10 13:37, 81 KB build)

- **2D performance with millions of voxels:** chunked scan storage (64×64
  columns), canvas rebuild touches only visible chunks, density-based LOD
  when zoomed out, rebuild throttling. Zoom/pan went from a full-map
  iteration per frame to ~1 ms.
- **gzip** for `/api/scan` and `/api/walked` (35 MB → ~10 MB).
- **Portal cleanup:** no-portal zones are cylinders (whole base height),
  false portals at world origin rejected, one-time migration merges
  duplicates and purges junk (with `portals.json.bak` backup). Portal list
  explains the counter ("traveled ×N").
- **Clicks/hover:** pointer cursor and underline on hoverable map labels,
  larger click targets.

## 0.2.x — 2026-07-10

- 0.2.2: fixed 2D map freeze (variable shadowing killed the render loop).
- 0.2.1: auto-detect trader NPCs (Employee Locator gates traveling traders),
  trader catalog from the wiki (10 traders, 170 trades), map tooltips with
  trade lists, clickable map labels.

## 0.1.x — 2026-07-08 … 2026-07-10

- 0.1.6: `start-server.py` launcher (replaces .bat quarantined by Nexus),
  README EN/RU.
- 0.1.4–0.1.5: initial public release. UE4SS Lua mod + stdlib Python server +
  WebGL/canvas web UI: lidar point-cloud auto-mapping, 2D/3D views, waypoints,
  elevators, portals, carts, A* routing that learns doors from where you
  walked, notes panel, EN/RU i18n, LAN/phone access.
