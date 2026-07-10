// AF LiveMap — 2D-вид сканированной карты + игроки/точки/маршрут.
// Холст рисует только скан (облако вокселей с фильтром по этажу), картинки
// секторов живут в отдельном попапе. Координаты мира (см) переводятся в
// «пиксели карты» фиксированным масштабом — калибровка не нужна.

"use strict";

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");

// Фиксированный масштаб 2D-вида: 1 px = 20 см (дальше работает zoom)
const WORLD_SCALE = 0.05;
const WORLD_TRANSFORM = { m11: WORLD_SCALE, m12: 0, m21: 0, m22: WORLD_SCALE, tx: 0, ty: 0 };

const TRAIL_MAX = 600;
const SCAN_CELL = 50;      // см, должно совпадать с ScanStore.CELL на сервере

const state = {
  // Камера: экран = (mapPx - camX) * zoom
  camX: 0, camY: 0, zoom: 1,
  follow: true,
  showTrail: true,
  players: [],             // из последнего SSE-события (мир игрока)
  world: "",               // мир, в котором игрок
  viewedWorld: null,       // мир, который смотрим (обычно = world)
  worlds: [],              // известные миры с сервера
  trails: new Map(),       // playerId -> [{x,y}] в px карты
  connected: false,
  lastMouse: null,
  centered: false,         // камера отцентрирована на игроке в этом мире
  scan: {
    // Воксели хранятся по колонкам, колонки — по чанкам 64×64: ребилд канваса
    // и поиск пола обходят только нужные чанки, а не все ~2 млн ячеек.
    columns: new Map(),    // "gx:gy" -> {gx, gy, zs: Map(gz -> count)}
    chunks: new Map(),     // "cx:cy" -> Set("gx:gy") (cx = gx >> 6)
    cellCount: 0,
    floorCache: null,      // кэш индекса пола для A*: {columns, version, walkedSize}
    version: 0,
    world: null,           // мир, для которого загружены ячейки
    canvas: null,          // offscreen-канвас видимого региона
    origin: { x: 0, y: 0 },// позиция канваса в px карты
    scale: 1,              // px канваса на px карты (при больших регионах < 1)
    view: null,            // {x0,y0,x1,y1} px карты — регион, для которого построен канвас
    dirty: false,
    dirty3d: false,
    lastRebuild: 0,        // троттлинг ребилда при зуме/пане
    builtZoom: 0,          // зум, при котором построен канвас (для staleness)
    refZ: null,            // опорная высота (z игрока, см) для цветов и выбора вокселя
  },
  view3d: false,
  floor3d: true,           // 3D: показывать только текущий этаж (±5 м)
  hover: null,             // {type, id} под курсором — подсветка и cursor:pointer
  walked: new Set(),       // "gx:gy:gz" — где игрок физически прошёл (двери и т.п.)
  walkedVersion: 0,
  waypoints: [],
  elevators: [],           // [{id, name, world, x, y, radius, doors, stops:[z...]}]
  elevatorRec: null,       // null | {samples: [{x, y, z, t}]} — идёт запись лифта
  carts: [],               // [{id, name, world, path: [[x,y,z]...]}] — тележки/рельсы
  cartRec: null,           // null | {samples: [{x, y, z, t}]} — идёт запись тележки
  traders: [],             // [{id, key, name, world, x, y, z}] — найденные торговцы
  traderCatalog: null,     // справочник обменов из web/traders-catalog.json
  portals: [],             // [{id, name, count, from:{world,x,y,z}, to:{world,x,y,z}}]
  portalIgnore: [],        // зоны «не портал»: [{id, name, world, x, y, z, radius}]
  prevLocal: null,         // прошлая позиция игрока — для автодетекта порталов
  lastDeathAt: 0,          // когда игрок последний раз был мёртв (подавление ложных порталов)
  route: {
    target: null,          // объект вейпоинта (с миром) — переживает смену мира просмотра
    points: [],
    lastCalc: 0,
    status: "",
  },
  selected: { type: null, id: null }, // выбранный на карте элемент (подсветка + связь)
};

// ==================== Преобразования ====================

function worldToImage(t, wx, wy) {
  return { x: t.m11 * wx + t.m12 * wy + t.tx, y: t.m21 * wx + t.m22 * wy + t.ty };
}

function imageToScreen(x, y) {
  return { x: (x - state.camX) * state.zoom, y: (y - state.camY) * state.zoom };
}

function screenToImage(x, y) {
  return { x: x / state.zoom + state.camX, y: y / state.zoom + state.camY };
}

function currentTransform() {
  return WORLD_TRANSFORM;
}

// ==================== Миры ====================

async function loadWorlds() {
  try {
    const resp = await fetch("/api/worlds");
    state.worlds = (await resp.json()).worlds || [];
    renderWorldSelect();
    // Игра не запущена — показываем первый известный мир, чтобы карта не пустовала
    if (!state.viewedWorld && state.worlds.length > 0) {
      switchViewedWorld(state.worlds[0]);
    }
  } catch (err) { /* server unavailable */ }
}

function renderWorldSelect() {
  const select = document.getElementById("worldSelect");
  const known = new Set(state.worlds);
  if (state.world && state.world !== "MainMenu") known.add(state.world);
  if (state.viewedWorld) known.add(state.viewedWorld);
  const worlds = [...known].sort();
  select.innerHTML = "";
  for (const world of worlds) {
    const option = document.createElement("option");
    option.value = world;
    option.textContent = world + (world === state.world ? t("world_player_here") : "");
    select.appendChild(option);
  }
  if (state.viewedWorld) select.value = state.viewedWorld;
}

function switchViewedWorld(world) {
  if (!world || state.viewedWorld === world) return;
  state.viewedWorld = world;
  state.centered = false;
  state.trails.clear();
  scanClear();
  state.scan.version = 0;
  state.scan.world = world;
  state.scan.epoch = undefined;
  state.scan.refZ = null;
  state.scan.view = null;
  state.scan.dirty = true;
  state.scan.dirty3d = true;
  state.walked.clear();
  state.walkedVersion = 0;
  if (view3dReady) {
    View3D.setCloud([]);
    View3D.clearRoute();
  }
  renderWorldSelect();
  loadWaypoints();
  loadElevators();
  loadPortals();
  loadCarts();
  loadTraders();
}

// ==================== Скан ====================

const CHUNK = 64; // колонок в чанке по каждой оси (64 × 50 см = 32 м)

function scanInsert(gx, gy, gz, count) {
  const colKey = gx + ":" + gy;
  let col = state.scan.columns.get(colKey);
  if (!col) {
    col = { gx, gy, zs: new Map() };
    state.scan.columns.set(colKey, col);
    const chunkKey = (gx >> 6) + ":" + (gy >> 6);
    let chunk = state.scan.chunks.get(chunkKey);
    if (!chunk) { chunk = new Set(); state.scan.chunks.set(chunkKey, chunk); }
    chunk.add(colKey);
  }
  if (count > 0) {
    if (!col.zs.has(gz)) state.scan.cellCount++;
    col.zs.set(gz, count);
  } else if (col.zs.delete(gz)) {
    state.scan.cellCount--; // надгробие: воксель стёрт карвингом
  }
}

function scanHas(gx, gy, gz) {
  const col = state.scan.columns.get(gx + ":" + gy);
  return !!col && col.zs.has(gz);
}

function scanClear() {
  state.scan.columns.clear();
  state.scan.chunks.clear();
  state.scan.cellCount = 0;
  state.scan.floorCache = null;
  state.scan.canvas = null;
  state.scan.view = null;
}

async function pollScan() {
  try {
    if (!state.viewedWorld) return;
    if (state.scan.world !== state.viewedWorld) {
      scanClear();
      state.scan.version = 0;
      state.scan.world = state.viewedWorld;
    }
    const resp = await fetch(`/api/scan?world=${encodeURIComponent(state.viewedWorld)}&since=${state.scan.version}`);
    const payload = await resp.json();
    if (payload.world !== state.scan.world) return;
    // Смена epoch = на сервере удалялись ячейки (например, чистка зоны лифта):
    // сбрасываем кэш и перезагружаем скан с нуля
    if (state.scan.epoch !== undefined && payload.epoch !== state.scan.epoch) {
      state.scan.epoch = payload.epoch;
      scanClear();
      state.scan.version = 0;
      state.scan.dirty = true;
      state.scan.dirty3d = true;
      return;
    }
    state.scan.epoch = payload.epoch;
    if (payload.cells.length > 0) {
      for (const [gx, gy, gz, count] of payload.cells) {
        scanInsert(gx, gy, gz, count);
      }
      state.scan.dirty = true;
      state.scan.dirty3d = true;
    }
    state.scan.version = payload.version;
  } catch (err) {
    // сервер недоступен — попробуем в следующий раз
  } finally {
    setTimeout(pollScan, 3000);
  }
}

// Цвет по перепаду высоты относительно игрока (см):
// ярко-голубой — твой уровень, зеленее — выше, темнее-синее — ниже
function scanBucket(dz) {
  if (dz < -900) return 0;
  if (dz < -450) return 1;
  if (dz < -150) return 2;
  if (dz <= 150) return 3;
  if (dz <= 450) return 4;
  if (dz <= 900) return 5;
  return 6;
}
const SCAN_BUCKET_COLORS = [
  "rgba(30, 58, 108, 0.55)",   // глубоко ниже
  "rgba(37, 99, 190, 0.65)",   // ниже
  "rgba(48, 150, 230, 0.75)",  // чуть ниже
  "rgba(56, 189, 248, 0.9)",   // уровень игрока
  "rgba(134, 239, 172, 0.8)",  // чуть выше
  "rgba(190, 242, 120, 0.6)",  // выше
  "rgba(148, 163, 184, 0.45)", // высоко выше
];

// Перерисовать offscreen-канвас скана для видимого региона (вьюпорт + запас).
// Обходим только чанки, попавшие в регион, — не весь скан. На колонку берётся
// воксель, ближайший по высоте к игроку; перепады высот читаются цветом.
// При сильном отдалении (LOD) рисуем чанки целиком: квадрат с яркостью по
// плотности вместо миллионов неразличимых точек.
function rebuildScanCanvas() {
  state.scan.dirty = false;
  state.scan.canvas = null;
  state.scan.lastRebuild = performance.now();
  state.scan.builtZoom = state.zoom;

  // Регион: вьюпорт + запас в полэкрана со всех сторон
  const vw = canvas.width / state.zoom;
  const vh = canvas.height / state.zoom;
  const x0 = state.camX - vw * 0.5;
  const y0 = state.camY - vh * 0.5;
  const x1 = state.camX + vw * 1.5;
  const y1 = state.camY + vh * 1.5;
  state.scan.view = { x0, y0, x1, y1 };

  if (state.scan.cellCount === 0) return;

  const viewing = state.world === state.viewedWorld;
  const refZ = (viewing && state.scan.refZ !== null) ? state.scan.refZ : null;
  const pxPerCell = SCAN_CELL * WORLD_SCALE;
  const chunkPx = CHUNK * pxPerCell; // 160 px карты на чанк

  // Диапазон чанков, накрывающих регион
  const cx0 = Math.floor(x0 / chunkPx), cx1 = Math.floor(x1 / chunkPx);
  const cy0 = Math.floor(y0 / chunkPx), cy1 = Math.floor(y1 / chunkPx);

  // Канвас региона; при большом регионе рисуем в уменьшенном масштабе
  const regionW = Math.ceil(x1 - x0);
  const regionH = Math.ceil(y1 - y0);
  const scale = Math.min(1, 4096 / regionW, 4096 / regionH);
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.ceil(regionW * scale));
  off.height = Math.max(1, Math.ceil(regionH * scale));
  const octx = off.getContext("2d");

  const cellDrawPx = pxPerCell * scale;
  const lod = cellDrawPx < 1.1; // клетка меньше пикселя — рисуем чанками

  if (lod) {
    const sizePx = chunkPx * scale;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = state.scan.chunks.get(cx + ":" + cy);
        if (!chunk || chunk.size === 0) continue;
        const density = chunk.size / (CHUNK * CHUNK);
        const alpha = Math.min(0.85, 0.18 + Math.sqrt(density) * 1.1);
        octx.fillStyle = `rgba(56, 189, 248, ${alpha.toFixed(2)})`;
        octx.fillRect((cx * chunkPx - x0) * scale, (cy * chunkPx - y0) * scale,
                      sizePx + 0.5, sizePx + 0.5);
      }
    }
  } else {
    // Плоские массивы координат по цветовым корзинам — минимум аллокаций
    const buckets = SCAN_BUCKET_COLORS.map(() => []);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = state.scan.chunks.get(cx + ":" + cy);
        if (!chunk) continue;
        for (const colKey of chunk) {
          const col = state.scan.columns.get(colKey);
          if (!col || col.zs.size === 0) continue;
          const px = (col.gx + 0.5) * pxPerCell;
          const py = (col.gy + 0.5) * pxPerCell;
          if (px < x0 || px > x1 || py < y0 || py > y1) continue;
          // Лучший воксель колонки: ближайший по высоте к игроку
          let bestGz = null, bestDz = Infinity;
          for (const gz of col.zs.keys()) {
            const dz = refZ === null ? 0 : Math.abs(gz * SCAN_CELL - refZ);
            if (bestGz === null || dz < bestDz) { bestGz = gz; bestDz = dz; }
          }
          const bucket = refZ === null ? 3 : scanBucket(bestGz * SCAN_CELL - refZ);
          buckets[bucket].push((px - x0) * scale, (py - y0) * scale);
        }
      }
    }
    const cellPx = Math.max(1.2, cellDrawPx);
    const half = cellPx / 2;
    for (let b = 0; b < buckets.length; b++) {
      const pts = buckets[b];
      if (pts.length === 0) continue;
      octx.fillStyle = SCAN_BUCKET_COLORS[b];
      for (let i = 0; i < pts.length; i += 2) {
        octx.fillRect(pts[i] - half, pts[i + 1] - half, cellPx, cellPx);
      }
    }
  }

  state.scan.canvas = off;
  state.scan.origin = { x: x0, y: y0 };
  state.scan.scale = scale;
}

// Вьюпорт вышел за построенный регион или зум заметно изменился —
// нужен новый канвас
function scanRegionStale() {
  const view = state.scan.view;
  if (!view) return true;
  const ratio = state.zoom / (state.scan.builtZoom || state.zoom);
  if (ratio > 1.4 || ratio < 0.7) return true;
  const vw = canvas.width / state.zoom;
  const vh = canvas.height / state.zoom;
  return state.camX < view.x0 || state.camY < view.y0 ||
         state.camX + vw > view.x1 || state.camY + vh > view.y1;
}

// ==================== Вейпоинты ====================

// В 3D-вид уходят и вейпоинты, и остановки лифтов (как маркеры с подписями)
function syncView3dMarkers() {
  if (!view3dReady) return;
  const markers = [...state.waypoints];
  for (const elevator of state.elevators) {
    for (const z of elevator.stops) {
      markers.push({ x: elevator.x, y: elevator.y, z, name: elevator.name });
    }
  }
  for (const portal of state.portals) {
    if (portal.from.world === state.viewedWorld) {
      markers.push({ x: portal.from.x, y: portal.from.y, z: portal.from.z, name: "◎ " + portal.name });
    }
    if (portal.to.world === state.viewedWorld) {
      markers.push({ x: portal.to.x, y: portal.to.y, z: portal.to.z, name: "◎ " + t("portal_exit_prefix") + portal.name });
    }
  }
  for (const cart of state.carts) {
    const first = cart.path[0];
    const last = cart.path[cart.path.length - 1];
    markers.push({ x: first[0], y: first[1], z: first[2], name: "⛟ " + cart.name });
    markers.push({ x: last[0], y: last[1], z: last[2], name: "⛟ " + cart.name });
  }
  View3D.setWaypoints(markers);
}

async function loadWaypoints() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/waypoints${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.waypoints = (await resp.json()).waypoints || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* server unavailable */ }
}

async function addWaypoint(name, x, y, z) {
  const resp = await fetch("/api/waypoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", name, world: state.world, x, y, z }),
  });
  if (resp.ok) await loadWaypoints();
}

async function deleteWaypoint(id) {
  if (state.route.target && state.route.target.id === id) clearRoute();
  await fetch("/api/waypoints", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  await loadWaypoints();
}

// Универсальные кнопки строк панели

function startRouteTo(pseudoId, name, world, x, y, z) {
  if (state.route.target && state.route.target.id === pseudoId) {
    clearRoute();
  } else {
    // Маршрут считается в мире игрока — возвращаем вид туда
    if (state.viewedWorld !== state.world && state.world && state.world !== "MainMenu") {
      switchViewedWorld(state.world);
    }
    state.route.target = { id: pseudoId, name, world, x, y, z };
    state.route.lastCalc = 0;
    recalcRoute();
  }
  renderWaypointList();
}

function makeButton(text, onclick, title) {
  const btn = document.createElement("button");
  btn.textContent = text;
  btn.onclick = onclick;
  if (title) btn.title = title;
  return btn;
}

function makeRouteButton(pseudoId, name, world, x, y, z, label) {
  const isActive = state.route.target && state.route.target.id === pseudoId;
  const btn = makeButton(isActive ? t("stop_btn") : (label || t("route_btn")),
    () => startRouteTo(pseudoId, name, world, x, y, z),
    t("route_title"));
  if (isActive) btn.className = "wp-active";
  return btn;
}

function makeRenameButton(endpoint, id, oldName, reload) {
  return makeButton("✎", async () => {
    const name = prompt(t("rename_prompt"), oldName);
    if (name === null || !name.trim()) return;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", id, name: name.trim() }),
    });
    if (!resp.ok) {
      alert(t("rename_failed"));
      return;
    }
    await reload();
  }, t("rename_btn_title"));
}

function makeRow(list, labelText, jumpPos, buttons, key) {
  const row = document.createElement("div");
  row.className = "wp-row";
  if (key) row.dataset.key = key;
  const name = document.createElement("span");
  name.className = "wp-name";
  name.title = t("show_on_map");
  name.textContent = labelText;
  // Клик по строке: подсветить на карте + прыжок; повторный клик — к следующему концу
  name.onclick = () => {
    if (key) {
      const i = key.indexOf(":");
      selectMapItem(key.slice(0, i), key.slice(i + 1));
    } else {
      jumpTo(jumpPos.x, jumpPos.y, jumpPos.z);
    }
  };
  row.appendChild(name);
  for (const btn of buttons) row.appendChild(btn);
  list.appendChild(row);
}

// Highlight the list row for the currently selected map item
function applyRowSelection() {
  const list = document.getElementById("waypointList");
  if (!list) return;
  const key = state.selected.type ? `${state.selected.type}:${state.selected.id}` : null;
  list.querySelectorAll(".wp-row.selected").forEach(r => r.classList.remove("selected"));
  if (!key) return;
  const row = list.querySelector(`.wp-row[data-key="${key}"]`);
  if (row) row.classList.add("selected");
  return row;
}

function renderWaypointList() {
  const list = document.getElementById("waypointList");
  list.innerHTML = "";
  if (state.waypoints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wp-name";
    empty.textContent = t("no_waypoints");
    list.appendChild(empty);
  }

  for (const wp of state.waypoints) {
    makeRow(list, wp.name, wp, [
      makeRenameButton("/api/waypoints", wp.id, wp.name, loadWaypoints),
      makeRouteButton(wp.id, wp.name, wp.world, wp.x, wp.y, wp.z),
      makeButton("×", () => {
        if (confirm(t("confirm_delete_waypoint", { name: wp.name }))) deleteWaypoint(wp.id);
      }, t("delete_btn")),
    ], `wp:${wp.id}`);
  }

  for (const tr of state.traders) {
    makeRow(list,
      t("trader_label", { name: tr.name }),
      tr,
      [
        makeRenameButton("/api/traders", tr.id, tr.name, loadTraders),
        makeRouteButton(tr.id, tr.name, tr.world, tr.x, tr.y, tr.z),
        makeButton("×", () => {
          if (confirm(t("confirm_delete_trader", { name: tr.name }))) deleteTrader(tr.id);
        }, t("delete_btn")),
      ], `trader:${tr.id}`);
  }

  for (const elevator of state.elevators) {
    makeRow(list,
      t("elevator_label", { name: elevator.name, n: elevator.stops.length,
        doors: elevator.doors ? t("elevator_doors_suffix") : "" }),
      { x: elevator.x, y: elevator.y, z: elevator.stops[0] },
      [
        makeRenameButton("/api/elevators", elevator.id, elevator.name, loadElevators),
        makeButton("×", () => {
          if (confirm(t("confirm_delete_elevator", { name: elevator.name }))) deleteElevator(elevator.id);
        }, t("delete_btn")),
      ], `elevator:${elevator.id}`);
  }

  for (const portal of state.portals) {
    const crossWorld = portal.from.world !== portal.to.world;
    const anchor = portal.from.world === state.viewedWorld ? portal.from : portal.to;
    makeRow(list,
      `◎ ${portal.name}${crossWorld ? ` (${portal.from.world} → ${portal.to.world})` : ""} · ${t("portal_uses", { n: portal.count })}`,
      anchor,
      [
        makeRenameButton("/api/portals", portal.id, portal.name, loadPortals),
        makeRouteButton(`portal:${portal.id}`, portal.name, anchor.world, anchor.x, anchor.y, anchor.z),
        makeButton("×", () => {
          if (confirm(t("confirm_delete_portal", { name: portal.name }))) deletePortal(portal.id);
        }, t("delete_btn")),
      ], `portal:${portal.id}`);
  }

  for (const zone of state.portalIgnore) {
    makeRow(list,
      t("zone_label", { name: zone.name, m: (zone.radius / 100).toFixed(0) }),
      zone,
      [
        makeRenameButton("/api/portals", zone.id, zone.name, loadPortals),
        makeButton("×", () => {
          if (confirm(t("confirm_delete_zone", { name: zone.name }))) {
            deletePortalIgnoreZone(zone.id);
          }
        }, t("delete_btn")),
      ], `zone:${zone.id}`);
  }

  for (const cart of state.carts) {
    const first = cart.path[0];
    const last = cart.path[cart.path.length - 1];
    makeRow(list,
      t("cart_label", { name: cart.name, m: cartLengthMeters(cart).toFixed(0) }),
      { x: first[0], y: first[1], z: first[2] },
      [
        makeRenameButton("/api/carts", cart.id, cart.name, loadCarts),
        makeRouteButton(`cart:${cart.id}:a`, t("cart_start_name", { name: cart.name }), cart.world, first[0], first[1], first[2], "▶A"),
        makeRouteButton(`cart:${cart.id}:b`, t("cart_end_name", { name: cart.name }), cart.world, last[0], last[1], last[2], "▶B"),
        makeButton("×", () => {
          if (confirm(t("confirm_delete_cart", { name: cart.name }))) deleteCart(cart.id);
        }, t("delete_btn")),
      ], `cart:${cart.id}`);
  }

  applyRowSelection();
}

// ==================== Лифты ====================

async function loadElevators() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/elevators${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.elevators = (await resp.json()).elevators || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* server unavailable */ }
}

async function deleteElevator(id) {
  await fetch("/api/elevators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  await loadElevators();
}

// ==================== Прохоженные клетки ====================
// Где игрок прошёл — там проходимо, что бы ни говорил скан (двери!)

async function pollWalked() {
  try {
    if (state.viewedWorld) {
      const resp = await fetch(`/api/walked?world=${encodeURIComponent(state.viewedWorld)}&since=${state.walkedVersion}`);
      const payload = await resp.json();
      if (payload.world === state.viewedWorld) {
        for (const [gx, gy, gz] of payload.cells) {
          state.walked.add(`${gx}:${gy}:${gz}`);
        }
        state.walkedVersion = payload.version;
      }
    }
  } catch (err) { /* server unavailable */ }
  setTimeout(pollWalked, 5000);
}

// Перейти камерой к точке мира (2D и 3D)
function jumpTo(x, y, z) {
  disableFollow();
  const point = worldToImage(currentTransform(), x, y);
  state.camX = point.x - canvas.width / (2 * state.zoom);
  state.camY = point.y - canvas.height / (2 * state.zoom);
  if (view3dReady && state.view3d) View3D.centerOn(x, y, z);
}

// ==================== Выбор элемента на карте ====================

// Экранные координаты мировой точки (см)
function worldScreen(wx, wy) {
  const p = worldToImage(currentTransform(), wx, wy);
  return imageToScreen(p.x, p.y);
}

// Расстояние от точки до отрезка (в пикселях экрана)
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let tt = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(px - (ax + dx * tt), py - (ay + dy * tt));
}

// Кликабельные прямоугольники подписей на карте. Заполняются при отрисовке
// (см. recordLabelBox), поэтому зона клика точно совпадает с тем, что видно.
let labelHitboxes = [];

// Вызывать сразу после ctx.fillText для подписи (шрифт уже выставлен).
// cx — центр текста, cy — базовая линия (как в fillText при textAlign=center).
function recordLabelBox(text, cx, cy, type, id) {
  const w = ctx.measureText(text).width;
  labelHitboxes.push({
    type, id,
    x0: cx - w / 2 - 5, x1: cx + w / 2 + 5,
    y0: cy - 14, y1: cy + 6,
  });
  // Подпись под курсором — подчёркиваем: видно, что по ней можно кликнуть
  if (state.hover && state.hover.type === type && state.hover.id === id) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2, cy + 2.5);
    ctx.lineTo(cx + w / 2, cy + 2.5);
    ctx.stroke();
    ctx.restore();
  }
}

// Что находится под кликом (в px экрана). Возвращает {type, id} или null.
function hitTestMap(sx, sy) {
  // Подписи проверяем первыми: если кликнули по названию — берём его.
  // Идём с конца: подпись, нарисованная последней, лежит сверху.
  for (let i = labelHitboxes.length - 1; i >= 0; i--) {
    const b = labelHitboxes[i];
    if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) {
      return { type: b.type, id: b.id };
    }
  }

  const HIT = 14; // радиус попадания, px
  let best = null, bestDist = HIT;
  const consider = (dist, type, id) => {
    if (dist <= bestDist) { bestDist = dist; best = { type, id }; }
  };

  for (const wp of state.waypoints) {
    const p = worldScreen(wp.x, wp.y);
    consider(Math.hypot(sx - p.x, sy - p.y), "wp", wp.id);
  }
  for (const tr of state.traders) {
    const p = worldScreen(tr.x, tr.y);
    consider(Math.hypot(sx - p.x, sy - p.y), "trader", tr.id);
  }
  for (const elevator of state.elevators) {
    const p = worldScreen(elevator.x, elevator.y);
    consider(Math.hypot(sx - p.x, sy - p.y), "elevator", elevator.id);
  }
  for (const zone of state.portalIgnore) {
    const p = worldScreen(zone.x, zone.y);
    consider(Math.hypot(sx - p.x, sy - p.y), "zone", zone.id);
  }
  for (const portal of state.portals) {
    for (const end of [portal.from, portal.to]) {
      if (end.world !== state.viewedWorld) continue;
      const p = worldScreen(end.x, end.y);
      consider(Math.hypot(sx - p.x, sy - p.y), "portal", portal.id);
    }
  }
  for (const cart of state.carts) {
    // Попадание по концам и по всей линии рельсов
    for (const idx of [0, cart.path.length - 1]) {
      const p = worldScreen(cart.path[idx][0], cart.path[idx][1]);
      consider(Math.hypot(sx - p.x, sy - p.y), "cart", cart.id);
    }
    for (let i = 1; i < cart.path.length; i++) {
      const a = worldScreen(cart.path[i - 1][0], cart.path[i - 1][1]);
      const b = worldScreen(cart.path[i][0], cart.path[i][1]);
      consider(distToSegment(sx, sy, a.x, a.y, b.x, b.y), "cart", cart.id);
    }
  }
  return best;
}

// Показать связь выбранного элемента в 3D-виде (2D рисует drawSelectionOverlay)
function updateSelection3d() {
  if (!view3dReady) return;
  const sel = state.selected;
  if (sel.type === "portal") {
    const p = state.portals.find(x => x.id === sel.id);
    if (p && p.from.world === state.viewedWorld && p.to.world === state.viewedWorld) {
      View3D.setSelectionLink([
        { x: p.from.x, y: p.from.y, z: p.from.z },
        { x: p.to.x, y: p.to.y, z: p.to.z },
      ]);
      return;
    }
  } else if (sel.type === "cart") {
    const c = state.carts.find(x => x.id === sel.id);
    if (c) {
      View3D.setSelectionLink(c.path.map(pp => ({ x: pp[0], y: pp[1], z: pp[2] })));
      return;
    }
  }
  View3D.clearSelectionLink();
}

// Все «концы» элемента (портал: вход/выход, тележка: начало/конец,
// лифт: этажи). Повторный клик перескакивает между ними.
function elementEndpoints(type, id) {
  if (type === "portal") {
    const p = state.portals.find(x => x.id === id);
    if (!p) return [];
    return [
      { world: p.from.world, x: p.from.x, y: p.from.y, z: p.from.z },
      { world: p.to.world, x: p.to.x, y: p.to.y, z: p.to.z },
    ];
  }
  if (type === "cart") {
    const c = state.carts.find(x => x.id === id);
    if (!c) return [];
    const f = c.path[0], l = c.path[c.path.length - 1];
    return [
      { world: c.world, x: f[0], y: f[1], z: f[2] },
      { world: c.world, x: l[0], y: l[1], z: l[2] },
    ];
  }
  if (type === "elevator") {
    const e = state.elevators.find(x => x.id === id);
    return e ? e.stops.map(z => ({ world: state.viewedWorld, x: e.x, y: e.y, z })) : [];
  }
  if (type === "wp") {
    const w = state.waypoints.find(x => x.id === id);
    return w ? [{ world: w.world, x: w.x, y: w.y, z: w.z }] : [];
  }
  if (type === "trader") {
    const tr = state.traders.find(x => x.id === id);
    return tr ? [{ world: tr.world, x: tr.x, y: tr.y, z: tr.z }] : [];
  }
  if (type === "zone") {
    const z = state.portalIgnore.find(x => x.id === id);
    return z ? [{ world: z.world, x: z.x, y: z.y, z: z.z }] : [];
  }
  return [];
}

function jumpToEndpoint(ep) {
  if (!ep) return;
  if (ep.world && ep.world !== state.viewedWorld) {
    switchViewedWorld(ep.world); // другой мир (кроссмировой портал) — переключаемся
  }
  jumpTo(ep.x, ep.y, ep.z);
}

// Выбрать элемент; повторный клик по уже выбранному — прыжок к следующему концу.
// screenPos (px экрана) при клике по карте: свежий выбор идёт к ближайшему концу.
function selectMapItem(type, id, screenPos) {
  const eps = elementEndpoints(type, id);
  const same = state.selected.type === type && state.selected.id === id;

  if (same && eps.length > 1) {
    state.selected.idx = ((state.selected.idx || 0) + 1) % eps.length;
    jumpToEndpoint(eps[state.selected.idx]);
  } else {
    let idx = 0;
    if (screenPos && eps.length > 1) {
      // ближайший к клику конец, чтобы следующий клик увёл к другому
      let best = Infinity;
      eps.forEach((ep, i) => {
        const s = worldScreen(ep.x, ep.y);
        const d = Math.hypot(s.x - screenPos.x, s.y - screenPos.y);
        if (d < best) { best = d; idx = i; }
      });
    } else if (eps.length) {
      jumpToEndpoint(eps[0]); // выбор из списка — сразу к первому концу
    }
    state.selected = { type, id, idx };
  }

  const panel = document.getElementById("waypointPanel");
  positionWaypointPanel();
  panel.classList.remove("hidden");
  const row = applyRowSelection();
  if (row) row.scrollIntoView({ block: "nearest" });
  updateSelection3d();
}

function clearMapSelection() {
  if (!state.selected.type) return;
  state.selected = { type: null, id: null };
  applyRowSelection();
  updateSelection3d();
}

// Клик по карте: выбрать элемент под курсором или снять выбор
function handleMapClick(sx, sy) {
  const hit = hitTestMap(sx, sy);
  if (hit) {
    selectMapItem(hit.type, hit.id, { x: sx, y: sy });
  } else {
    clearMapSelection();
  }
}

// ==================== Тележки (рельсовый транспорт) ====================

async function loadCarts() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/carts${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.carts = (await resp.json()).carts || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* server unavailable */ }
}

async function deleteCart(id) {
  await fetch("/api/carts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  await loadCarts();
}

function cartLengthMeters(cart) {
  let length = 0;
  for (let i = 1; i < cart.path.length; i++) {
    length += Math.hypot(
      cart.path[i][0] - cart.path[i - 1][0],
      cart.path[i][1] - cart.path[i - 1][1],
      cart.path[i][2] - cart.path[i - 1][2]);
  }
  return length / 100;
}

async function finishCartRecording() {
  const samples = state.cartRec.samples;
  state.cartRec = null;
  const btn = document.getElementById("cartBtn");
  btn.classList.remove("recording");
  btn.textContent = t("cart");

  // Thin out the path: one point every >= 1.5 m
  const path = [];
  for (const s of samples) {
    const last = path[path.length - 1];
    if (!last || Math.hypot(s.x - last[0], s.y - last[1], s.z - last[2]) >= 150) {
      path.push([Math.round(s.x), Math.round(s.y), Math.round(s.z)]);
    }
  }
  const length = path.length >= 2 ? cartLengthMeters({ path }) : 0;
  if (path.length < 3 || length < 10) {
    alert(t("cart_too_short"));
    return;
  }
  const name = prompt(t("cart_prompt", { m: length.toFixed(0) }),
    t("cart_default_name", { n: state.carts.length + 1 }));
  if (name === null) return;

  const resp = await fetch("/api/carts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", name: (name || t("cart_default_base")).trim(), world: state.world, path }),
  });
  if (resp.ok) {
    await loadCarts();
    state.route.lastCalc = 0;
  } else {
    alert(t("save_failed") + (await resp.text()));
  }
}

// ==================== Торговцы ====================
// Позиция запоминается тобой (значит, ты его нашёл и поговорил), а список
// обменов и иконки берутся из справочника traders-catalog.json (данные вики).

async function loadTraderCatalog() {
  try {
    const resp = await fetch("/traders-catalog.json");
    state.traderCatalog = await resp.json();
  } catch (err) { state.traderCatalog = { traders: [] }; }
}

function catalogEntry(key) {
  if (!state.traderCatalog) return null;
  return state.traderCatalog.traders.find(t => t.key === key) || null;
}

async function loadTraders() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/traders${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.traders = (await resp.json()).traders || [];
    renderWaypointList();
  } catch (err) { /* server unavailable */ }
}

// Мод находит торговцев сам — подтягиваем их периодически
async function pollTraders() {
  try {
    if (state.viewedWorld) {
      const resp = await fetch(`/api/traders?world=${encodeURIComponent(state.viewedWorld)}`);
      const fresh = (await resp.json()).traders || [];
      if (JSON.stringify(fresh) !== JSON.stringify(state.traders)) {
        state.traders = fresh;
        renderWaypointList();
      }
    }
  } catch (err) { /* server unavailable */ }
  setTimeout(pollTraders, 5000);
}

async function addTrader(key, name, x, y, z) {
  const resp = await fetch("/api/traders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", key, name, world: state.world, x, y, z }),
  });
  if (resp.ok) await loadTraders();
}

async function deleteTrader(id) {
  if (state.selected.type === "trader" && state.selected.id === id) clearMapSelection();
  await fetch("/api/traders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  await loadTraders();
}

// Тултип: что торговец даёт и что просит взамен
function buildTraderTooltip(trader) {
  const box = document.getElementById("traderTooltip");
  box.innerHTML = "";
  const entry = catalogEntry(trader.key);

  const title = document.createElement("h4");
  title.textContent = trader.name;
  box.appendChild(title);

  if (entry && entry.location) {
    const loc = document.createElement("div");
    loc.className = "tt-loc";
    loc.textContent = entry.location + (entry.kind ? ` · ${entry.kind}` : "");
    box.appendChild(loc);
  }

  if (!entry || !entry.trades.length) {
    const none = document.createElement("div");
    none.textContent = t("trader_sells_nothing");
    box.appendChild(none);
    return;
  }

  const side = (items) => {
    const wrap = document.createElement("span");
    wrap.className = "tt-side";
    for (const it of items || []) {
      if (it.icon) {
        const img = document.createElement("img");
        img.src = it.icon;
        img.alt = it.name;
        img.loading = "lazy";
        wrap.appendChild(img);
      }
      const label = document.createElement("span");
      label.textContent = (it.qty ? it.qty + "× " : "") + it.name;
      wrap.appendChild(label);
    }
    return wrap;
  };

  for (const trade of entry.trades) {
    const row = document.createElement("div");
    row.className = "tt-row";
    row.appendChild(side(trade.cost));           // что отдаёшь
    const arrow = document.createElement("span");
    arrow.className = "tt-arrow";
    arrow.textContent = "→";
    row.appendChild(arrow);
    row.appendChild(side(trade.buy));            // что получаешь
    box.appendChild(row);

    if (trade.note || trade.unlocked) {
      const sub = document.createElement("div");
      sub.className = "tt-unlock";
      sub.textContent = trade.note || t("trader_unlock", { text: trade.unlocked });
      box.appendChild(sub);
    }
  }
}

function showTraderTooltip(trader, sx, sy) {
  const box = document.getElementById("traderTooltip");
  if (box.dataset.traderId !== trader.id) {
    box.dataset.traderId = trader.id;
    buildTraderTooltip(trader);
  }
  box.classList.remove("hidden");
  // Держим тултип в пределах окна
  const w = box.offsetWidth, h = box.offsetHeight;
  let x = sx + 16, y = sy + 16;
  if (x + w > window.innerWidth - 8) x = sx - w - 16;
  if (y + h > window.innerHeight - 8) y = Math.max(8, window.innerHeight - h - 8);
  box.style.left = x + "px";
  box.style.top = y + "px";
}

function hideTraderTooltip() {
  const box = document.getElementById("traderTooltip");
  box.classList.add("hidden");
  box.dataset.traderId = "";
}

// Торговец под курсором (по маркеру или по подписи)
function traderAt(sx, sy) {
  for (const b of labelHitboxes) {
    if (b.type === "trader" && sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) {
      return state.traders.find(x => x.id === b.id) || null;
    }
  }
  for (const tr of state.traders) {
    const p = worldScreen(tr.x, tr.y);
    if (Math.hypot(sx - p.x, sy - p.y) <= 14) return tr;
  }
  return null;
}

// ==================== Порталы ====================

async function loadPortals() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/portals${world ? "?world=" + encodeURIComponent(world) : ""}`);
    const payload = await resp.json();
    state.portals = payload.portals || [];
    state.portalIgnore = payload.ignore || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* server unavailable */ }
}

// Цилиндр, как на сервере: радиус по горизонтали, по высоте — вся база
// (иначе телепорт с этажа на этаж внутри базы даёт ложный портал)
function inPortalIgnoreZone(world, x, y, z) {
  return state.portalIgnore.some(zone =>
    zone.world === world &&
    Math.hypot(x - zone.x, y - zone.y) < zone.radius &&
    Math.abs(z - zone.z) <= Math.max(2000, zone.radius));
}

async function addPortalIgnoreZone(name, radius, x, y, z) {
  const resp = await fetch("/api/portals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add_ignore", name, world: state.world, x, y, z, radius }),
  });
  if (resp.ok) {
    const result = await resp.json();
    await loadPortals();
    alert(t("zone_created", { name, m: (radius / 100).toFixed(0), purged: result.purgedPortals }));
  }
}

async function deletePortalIgnoreZone(id) {
  await fetch("/api/portals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_ignore", id }),
  });
  await loadPortals();
}

async function deletePortal(id) {
  await fetch("/api/portals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id }),
  });
  await loadPortals();
}

// Автодетект: телепорт = скачок > 25 м за тик или смена мира без выхода в меню
const PORTAL_JUMP_CM = 2500;

async function reportPortal(from, to) {
  // Телепорт в зону «не портал» (например, предметом на базу) — не записываем
  if (inPortalIgnoreZone(to.world, to.x, to.y, to.z)) return;
  const crossWorld = from.world !== to.world;
  const name = crossWorld ? t("portal_name_cross", { world: to.world }) : t("portal_name");
  try {
    const resp = await fetch("/api/portals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", name, from, to }),
    });
    if (resp.ok) {
      const result = await resp.json();
      if (!result.duplicate) {
        console.info(t("new_portal_console"), result.portal);
      }
      await loadPortals();
      state.route.lastCalc = 0;
    }
  } catch (err) { /* server unavailable */ }
}

// Подавление после смерти: телепорт на респаун — не портал.
// Таймер, а не мгновенная проверка: в момент скачка игрок уже «жив».
const DEATH_SUPPRESS_MS = 15000;

function detectPortal(local) {
  const now = Date.now();
  const prev = state.prevLocal;
  const current = { world: state.world, x: local.x, y: local.y, z: local.z, t: now };

  if (local.isDead) state.lastDeathAt = now;

  // Меню = разрыв сессии, детект не делаем
  if (!state.world || state.world === "MainMenu") {
    state.prevLocal = null;
    return;
  }
  // Позиция у (0,0,0) — transient-чтение пешки при загрузке, а не телепорт.
  // Рвём цепочку, чтобы и следующий реальный кадр не дал ложный «скачок».
  if (Math.hypot(local.x, local.y, local.z) < 200) {
    state.prevLocal = null;
    return;
  }
  if (!prev) {
    state.prevLocal = current;
    return;
  }
  if (now - state.lastDeathAt < DEATH_SUPPRESS_MS) {
    // Недавно умирал: скачок = респаун, портал не записываем
    state.prevLocal = current;
    return;
  }

  if (prev.world === current.world) {
    // Телепорт внутри мира: большой скачок за короткое время
    const dist = Math.hypot(current.x - prev.x, current.y - prev.y, current.z - prev.z);
    if (dist > PORTAL_JUMP_CM && now - prev.t < 700) {
      reportPortal(
        { world: prev.world, x: prev.x, y: prev.y, z: prev.z },
        { world: current.world, x: current.x, y: current.y, z: current.z }
      );
    }
  } else if (now - prev.t < 90000) {
    // Смена мира без захода в меню (загрузочный экран допускаем до 90 с)
    reportPortal(
      { world: prev.world, x: prev.x, y: prev.y, z: prev.z },
      { world: current.world, x: current.x, y: current.y, z: current.z }
    );
  }
  state.prevLocal = current;
}

// Остановки лифта из записи: «плато» — z стабилен >= 1.2 c (разброс < 40 см)
function detectElevatorStops(samples) {
  const stops = [];
  let i = 0;
  while (i < samples.length) {
    let j = i;
    let zMin = samples[i].z, zMax = samples[i].z;
    while (j + 1 < samples.length) {
      const nz = samples[j + 1].z;
      if (Math.max(zMax, nz) - Math.min(zMin, nz) > 40) break;
      j++;
      zMin = Math.min(zMin, nz);
      zMax = Math.max(zMax, nz);
    }
    if (samples[j].t - samples[i].t >= 1200) {
      stops.push((zMin + zMax) / 2);
    }
    i = j + 1;
  }
  stops.sort((a, b) => a - b);
  const merged = [];
  for (const z of stops) {
    if (merged.length && Math.abs(z - merged[merged.length - 1]) < 150) continue;
    merged.push(z);
  }
  return merged;
}

async function finishElevatorRecording() {
  const samples = state.elevatorRec.samples;
  state.elevatorRec = null;
  document.getElementById("elevatorBtn").classList.remove("recording");
  document.getElementById("elevatorBtn").textContent = t("elevator");

  if (samples.length < 10) {
    alert(t("elevator_too_short"));
    return;
  }
  const stops = detectElevatorStops(samples);
  if (stops.length < 2) {
    alert(t("elevator_few_stops", { n: stops.length }));
    return;
  }
  // Zone center and radius from the horizontal spread of the recording
  const cx = samples.reduce((s, p) => s + p.x, 0) / samples.length;
  const cy = samples.reduce((s, p) => s + p.y, 0) / samples.length;
  const spread = Math.max(...samples.map(p => Math.hypot(p.x - cx, p.y - cy)));
  if (spread > 700) {
    alert(t("elevator_too_far"));
    return;
  }
  const name = prompt(t("elevator_prompt", { n: stops.length }),
    t("elevator_default_name", { n: state.elevators.length + 1 }));
  if (name === null) return;
  // Elevators with doors get a wider zone: doors are a "flickering" wall in the scan, excluded too
  const doors = confirm(t("elevator_doors_confirm"));

  const resp = await fetch("/api/elevators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add",
      name: (name || t("elevator")).trim(),
      world: state.world,
      x: cx, y: cy,
      radius: Math.max(200, spread + 100) + (doors ? 80 : 0),
      doors,
      stops,
    }),
  });
  if (resp.ok) {
    const result = await resp.json();
    await loadElevators();
    state.route.lastCalc = 0;
    alert(t("elevator_saved", { n: stops.length, cells: result.purgedCells }));
  } else {
    alert(t("elevator_save_failed") + (await resp.text()));
  }
}

function clearRoute() {
  state.route.target = null;
  state.route.points = [];
  state.route.status = "";
  if (view3dReady) View3D.clearRoute();
  document.getElementById("routeStatus").textContent = "";
}

// ==================== Автомаршрут (A* по сканированному полу) ====================

function buildFloorIndex() {
  // Дорогой обход всех колонок (~1 с на 1.7 млн вокселей) — кэшируем.
  // Пока идёт скан, version меняется каждый поллинг: перестраиваем не чаще
  // раза в 15 с — маршруту не нужен мгновенно свежий пол
  const cache = state.scan.floorCache;
  if (cache && ((cache.version === state.scan.version &&
                 cache.walkedSize === state.walked.size) ||
                performance.now() - cache.at < 15000)) {
    return cache.columns;
  }
  const columns = new Map(); // "gx:gy" -> [gz пола, ...]
  for (const col of state.scan.columns.values()) {
    if (col.zs.size === 0) continue;
    // Пол = воксель без вокселей на 1–3 клетки выше (нет потолка вплотную)
    let floors = null;
    for (const gz of col.zs.keys()) {
      if (col.zs.has(gz + 1) || col.zs.has(gz + 2) || col.zs.has(gz + 3)) continue;
      if (!floors) { floors = []; columns.set(col.gx + ":" + col.gy, floors); }
      floors.push(gz);
    }
  }
  // Прохоженные клетки — проходимы всегда, даже если скан видит там «стену»
  // (закрытую дверь): игрок ходил — значит, можно
  for (const key of state.walked) {
    const [gx, gy, gz] = key.split(":").map(Number);
    const columnKey = `${gx}:${gy}`;
    let floors = columns.get(columnKey);
    if (!floors) { floors = []; columns.set(columnKey, floors); }
    if (!floors.some(z => Math.abs(z - gz) <= 1)) floors.push(gz);
  }
  state.scan.floorCache = {
    columns, version: state.scan.version, walkedSize: state.walked.size,
    at: performance.now(),
  };
  return columns;
}

function nearestFloorNode(columns, x, y, z) {
  const gx = Math.floor(x / SCAN_CELL), gy = Math.floor(y / SCAN_CELL), gz = Math.floor(z / SCAN_CELL);
  let best = null, bestDist = Infinity;
  const RADIUS = 8;
  for (let dx = -RADIUS; dx <= RADIUS; dx++) {
    for (let dy = -RADIUS; dy <= RADIUS; dy++) {
      const floors = columns.get(`${gx + dx}:${gy + dy}`);
      if (!floors) continue;
      for (const fz of floors) {
        const dist = dx * dx + dy * dy + (fz - gz) * (fz - gz) * 4;
        if (dist < bestDist) {
          bestDist = dist;
          best = { gx: gx + dx, gy: gy + dy, gz: fz };
        }
      }
    }
  }
  return best;
}

// Специальные рёбра графа: лифты (соседние остановки, эт.1 ↔ эт.2 ↔ эт.3 …)
// и порталы внутри мира (вход → выход, направленно)
function buildSpecialEdges(columns) {
  const key = n => `${n.gx}:${n.gy}:${n.gz}`;
  const edges = new Map(); // nodeKey -> [{node, cost, via}]
  const addEdge = (a, b, cost, via) => {
    const aKey = key(a);
    let list = edges.get(aKey);
    if (!list) { list = []; edges.set(aKey, list); }
    list.push({ node: b, cost, via: via || null });
  };
  for (const elevator of state.elevators) {
    const nodes = elevator.stops.map(z => nearestFloorNode(columns, elevator.x, elevator.y, z));
    for (let i = 0; i + 1 < nodes.length; i++) {
      const a = nodes[i], b = nodes[i + 1];
      if (!a || !b) continue;
      // стоимость: посадка + подъём (дешевле, чем длинный обход по лестницам)
      const cost = 6 + Math.abs(elevator.stops[i + 1] - elevator.stops[i]) / SCAN_CELL * 0.3;
      addEdge(a, b, cost);
      addEdge(b, a, cost);
    }
  }
  for (const portal of state.portals) {
    if (portal.from.world !== state.world || portal.to.world !== state.world) continue;
    const a = nearestFloorNode(columns, portal.from.x, portal.from.y, portal.from.z);
    const b = nearestFloorNode(columns, portal.to.x, portal.to.y, portal.to.z);
    if (!a || !b) continue;
    addEdge(a, b, 5); // направленно: вход -> выход
  }
  for (const cart of state.carts) {
    const first = cart.path[0];
    const last = cart.path[cart.path.length - 1];
    const a = nearestFloorNode(columns, first[0], first[1], first[2]);
    const b = nearestFloorNode(columns, last[0], last[1], last[2]);
    if (!a || !b) continue;
    // Ехать дёшево: посадка + четверть стоимости пешего пути той же длины
    const cost = 6 + cartLengthMeters(cart) * 100 / SCAN_CELL * 0.25;
    const via = cart.path.map(p => ({ x: p[0], y: p[1], z: p[2] }));
    addEdge(a, b, cost, via);
    addEdge(b, a, cost, [...via].reverse());
  }
  return edges;
}

function findPath(columns, start, goal, extraEdges) {
  const key = n => `${n.gx}:${n.gy}:${n.gz}`;
  const goalKey = key(goal);
  const heuristic = n => Math.hypot(n.gx - goal.gx, n.gy - goal.gy, (n.gz - goal.gz) * 2);

  const open = [{ node: start, f: heuristic(start) }];
  const gScore = new Map([[key(start), 0]]);
  const cameFrom = new Map();
  const closed = new Set();
  const MAX_ITERATIONS = 120000;

  let iterations = 0;
  while (open.length > 0 && iterations++ < MAX_ITERATIONS) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const { node } = open.splice(bestIdx, 1)[0];
    const nodeKey = key(node);
    if (closed.has(nodeKey)) continue;
    closed.add(nodeKey);

    if (nodeKey === goalKey) {
      // Восстановление: узлы + промежуточные via-точки (траектории тележек)
      const steps = [{ node, via: null }];
      let k = nodeKey;
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k);
        steps.push(prev);
        k = key(prev.node);
      }
      return steps.reverse();
    }

    const g = gScore.get(nodeKey);
    const relax = (neighbor, stepCost, via) => {
      const neighborKey = key(neighbor);
      if (closed.has(neighborKey)) return;
      const cost = g + stepCost;
      if (cost < (gScore.get(neighborKey) ?? Infinity)) {
        gScore.set(neighborKey, cost);
        cameFrom.set(neighborKey, { node, via: via || null });
        open.push({ node: neighbor, f: cost + heuristic(neighbor) });
      }
    };
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const floors = columns.get(`${node.gx + dx}:${node.gy + dy}`);
        if (!floors) continue;
        for (const fz of floors) {
          if (Math.abs(fz - node.gz) > 1) continue;
          relax({ gx: node.gx + dx, gy: node.gy + dy, gz: fz },
                Math.hypot(dx, dy) + Math.abs(fz - node.gz) * 0.5);
        }
      }
    }
    const extras = extraEdges && extraEdges.get(nodeKey);
    if (extras) {
      for (const edge of extras) relax(edge.node, edge.cost, edge.via);
    }
  }
  return null;
}

function recalcRoute() {
  if (!state.route.target) return;
  const statusEl = document.getElementById("routeStatus");
  if (state.viewedWorld !== state.world) {
    statusEl.textContent = t("route_need_player_world");
    return;
  }
  const now = Date.now();
  if (now - state.route.lastCalc < 3000) return;
  state.route.lastCalc = now;

  let target = state.route.target;
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!target || !local) return;

  // Target in another world: route to the entrance of a portal that teleports there
  let portalHint = "";
  if (target.world && target.world !== state.world) {
    const gate = state.portals.find(
      p => p.from.world === state.world && p.to.world === target.world);
    if (!gate) {
      state.route.points = [];
      state.route.status = t("route_target_other_world", { world: target.world });
      statusEl.textContent = state.route.status;
      if (view3dReady) View3D.clearRoute();
      return;
    }
    portalHint = t("route_via_portal", { name: gate.name });
    target = { name: target.name, x: gate.from.x, y: gate.from.y, z: gate.from.z };
  }

  const columns = buildFloorIndex();
  const start = nearestFloorNode(columns, local.x, local.y, local.z);
  const goal = nearestFloorNode(columns, target.x, target.y, target.z);
  if (!start || !goal) {
    state.route.points = [];
    state.route.status = t("route_no_floor");
    statusEl.textContent = state.route.status;
    if (view3dReady) View3D.clearRoute();
    return;
  }

  const path = findPath(columns, start, goal, buildSpecialEdges(columns));
  if (!path) {
    state.route.points = [];
    state.route.status = t("route_not_found");
    statusEl.textContent = state.route.status;
    if (view3dReady) View3D.clearRoute();
    return;
  }

  state.route.points = [];
  for (const step of path) {
    state.route.points.push({
      x: (step.node.gx + 0.5) * SCAN_CELL,
      y: (step.node.gy + 0.5) * SCAN_CELL,
      z: (step.node.gz + 1) * SCAN_CELL,
    });
    if (step.via) {
      for (const v of step.via) state.route.points.push({ x: v.x, y: v.y, z: v.z });
    }
  }
  const lengthMeters = state.route.points.reduce((sum, p, i, arr) =>
    i === 0 ? 0 : sum + Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y, p.z - arr[i - 1].z) / 100, 0);
  state.route.status = t("route_to", { name: target.name, m: lengthMeters.toFixed(0), hint: portalHint });
  statusEl.textContent = state.route.status;
  if (view3dReady) View3D.setRoute(state.route.points);
}

// ==================== SSE ====================

function connectStream() {
  const statusEl = document.getElementById("status");
  const source = new EventSource("/api/stream");
  let lastPlayerWorld = null;

  source.onopen = () => {
    state.connected = true;
    statusEl.textContent = t("status_connected");
    statusEl.className = "status-ok";
  };

  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.state) return;
    state.players = payload.state.players || [];
    state.world = payload.state.world || "";

    // Auto-switch to the player's world when it changes
    if (state.world !== lastPlayerWorld) {
      lastPlayerWorld = state.world;
      if (state.world && state.world !== "MainMenu") {
        switchViewedWorld(state.world);
        loadWorlds();
      }
      renderWorldSelect();
    }

    const viewing = state.viewedWorld === state.world;
    statusEl.textContent = t("status_online", { n: state.players.length, world: state.world })
      + (viewing ? "" : t("status_viewing", { world: state.viewedWorld }));
    statusEl.className = "status-ok";

    if (viewing) updateTrails();

    const local = state.players.find(p => p.isLocal) || state.players[0];
    if (local) detectPortal(local);
    // Elevator recording: accumulate player positions
    if (state.elevatorRec && local) {
      state.elevatorRec.samples.push({ x: local.x, y: local.y, z: local.z, t: Date.now() });
      document.getElementById("elevatorBtn").textContent =
        t("elevator_btn_stop_stops", { n: detectElevatorStops(state.elevatorRec.samples).length });
    }
    // Cart recording: accumulate the path
    if (state.cartRec && local) {
      state.cartRec.samples.push({ x: local.x, y: local.y, z: local.z, t: Date.now() });
      const first = state.cartRec.samples[0];
      const dist = Math.hypot(local.x - first.x, local.y - first.y, local.z - first.z) / 100;
      document.getElementById("cartBtn").textContent = t("cart_btn_stop", { m: dist.toFixed(0) });
    }
    if (local && view3dReady) View3D.setPlayerPos(local.x, local.y, local.z);
    if (state.view3d && view3dReady) {
      View3D.setPlayers(viewing ? state.players : []);
      if (state.scan.dirty3d) rebuildCloud();
      if (state.follow && local && viewing) View3D.centerOn(local.x, local.y, local.z);
    }
    recalcRoute();

    if (local && viewing) {
      // Опорная высота для 2D: обновляем при изменении > 1.5 м, чтобы не
      // перерисовывать скан на каждом шаге по лестнице
      if (state.scan.refZ === null || Math.abs(local.z - state.scan.refZ) > 150) {
        state.scan.refZ = local.z;
        state.scan.dirty = true;
        if (state.floor3d) state.scan.dirty3d = true; // сменился этаж — облако тоже
      }
      if (!state.centered) {
        const point = worldToImage(currentTransform(), local.x, local.y);
        state.camX = point.x - canvas.width / (2 * state.zoom);
        state.camY = point.y - canvas.height / (2 * state.zoom);
        state.centered = true;
      }
    }
  };

  source.onerror = () => {
    state.connected = false;
    statusEl.textContent = t("status_no_connection");
    statusEl.className = "status-err";
  };
}

function updateTrails() {
  const tf = currentTransform();
  const alive = new Set();
  for (const player of state.players) {
    alive.add(player.id);
    const point = worldToImage(tf, player.x, player.y);
    let trail = state.trails.get(player.id);
    if (!trail) {
      trail = [];
      state.trails.set(player.id, trail);
    }
    const last = trail[trail.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.5) {
      trail.push(point);
      if (trail.length > TRAIL_MAX) trail.shift();
    }
  }
  for (const id of state.trails.keys()) {
    if (!alive.has(id)) state.trails.delete(id);
  }
}

// ==================== Рендер 2D ====================

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

function draw() {
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  labelHitboxes = []; // пересобираем зоны клика по подписям каждый кадр

  const tf = currentTransform();
  const viewing = state.viewedWorld === state.world;

  // Скан. Перестройка канваса дорогая — не чаще ~7 раз/сек: во время зума
  // и пана старый канвас просто масштабируется, интерфейс не подвисает
  if ((state.scan.dirty || scanRegionStale()) &&
      (!state.scan.canvas || performance.now() - state.scan.lastRebuild > 140)) {
    rebuildScanCanvas();
  }
  if (state.scan.canvas) {
    const pos = imageToScreen(state.scan.origin.x, state.scan.origin.y);
    const displayScale = state.zoom / state.scan.scale;
    ctx.imageSmoothingEnabled = state.scan.scale < 1;
    ctx.drawImage(
      state.scan.canvas, pos.x, pos.y,
      state.scan.canvas.width * displayScale, state.scan.canvas.height * displayScale
    );
  }

  // Следы
  if (state.showTrail && viewing) {
    for (const [id, trail] of state.trails) {
      if (trail.length < 2) continue;
      const player = state.players.find(p => p.id === id);
      ctx.strokeStyle = player && player.isLocal ? "rgba(63,185,80,0.5)" : "rgba(88,166,255,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      const start = imageToScreen(trail[0].x, trail[0].y);
      ctx.moveTo(start.x, start.y);
      for (let i = 1; i < trail.length; i++) {
        const pos = imageToScreen(trail[i].x, trail[i].y);
        ctx.lineTo(pos.x, pos.y);
      }
      ctx.stroke();
    }
  }

  // Маршрут
  if (viewing && state.route.points.length > 1) {
    ctx.strokeStyle = "rgba(255, 220, 60, 0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    const startPoint = worldToImage(tf, state.route.points[0].x, state.route.points[0].y);
    const startScreen = imageToScreen(startPoint.x, startPoint.y);
    ctx.moveTo(startScreen.x, startScreen.y);
    for (let i = 1; i < state.route.points.length; i++) {
      const point = worldToImage(tf, state.route.points[i].x, state.route.points[i].y);
      const screen = imageToScreen(point.x, point.y);
      ctx.lineTo(screen.x, screen.y);
    }
    ctx.stroke();
  }

  // Лифты: круг зоны + символ
  for (const elevator of state.elevators) {
    const point = worldToImage(tf, elevator.x, elevator.y);
    const pos = imageToScreen(point.x, point.y);
    const radius = elevator.radius * WORLD_SCALE * state.zoom;
    ctx.strokeStyle = "rgba(255, 165, 60, 0.9)";
    ctx.fillStyle = "rgba(255, 165, 60, 0.15)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, Math.max(6, radius), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffa53c";
    ctx.font = "bold 13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("⬍", pos.x, pos.y + 4);
    ctx.font = "12px sans-serif";
    const elevLabel = t("elevator_map_label", { name: elevator.name, n: elevator.stops.length });
    const elevLabelY = pos.y - Math.max(6, radius) - 4;
    ctx.fillText(elevLabel, pos.x, elevLabelY);
    recordLabelBox(elevLabel, pos.x, elevLabelY, "elevator", elevator.id);
    ctx.textAlign = "left";
  }

  // Тележки: зелёная пунктирная линия рельсов + метки концов
  for (const cart of state.carts) {
    ctx.strokeStyle = "rgba(74, 222, 128, 0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    let started = false;
    for (const p of cart.path) {
      const point = worldToImage(tf, p[0], p[1]);
      const pos = imageToScreen(point.x, point.y);
      if (!started) { ctx.moveTo(pos.x, pos.y); started = true; }
      else ctx.lineTo(pos.x, pos.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const idx of [0, cart.path.length - 1]) {
      const point = worldToImage(tf, cart.path[idx][0], cart.path[idx][1]);
      const pos = imageToScreen(point.x, point.y);
      ctx.fillStyle = "#4ade80";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    const mid = cart.path[Math.floor(cart.path.length / 2)];
    const midPoint = worldToImage(tf, mid[0], mid[1]);
    const midPos = imageToScreen(midPoint.x, midPoint.y);
    ctx.fillStyle = "#86efac";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const cartLabel = `⛟ ${cart.name}`;
    ctx.fillText(cartLabel, midPos.x, midPos.y - 8);
    recordLabelBox(cartLabel, midPos.x, midPos.y - 8, "cart", cart.id);
    ctx.textAlign = "left";
  }

  // Зоны «не портал»: серый пунктирный круг
  for (const zone of state.portalIgnore) {
    const point = worldToImage(tf, zone.x, zone.y);
    const pos = imageToScreen(point.x, point.y);
    const radius = Math.max(8, zone.radius * WORLD_SCALE * state.zoom);
    ctx.strokeStyle = "rgba(139, 148, 158, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#8b949e";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    const zoneLabel = `🚫 ${zone.name}`;
    ctx.fillText(zoneLabel, pos.x, pos.y - radius - 4);
    recordLabelBox(zoneLabel, pos.x, pos.y - radius - 4, "zone", zone.id);
    ctx.textAlign = "left";
  }

  // Порталы: вход ◎, выход ◌, для внутримировых — пунктир между ними
  for (const portal of state.portals) {
    const drawPortalMark = (p, label, isExit) => {
      const point = worldToImage(tf, p.x, p.y);
      const pos = imageToScreen(point.x, point.y);
      ctx.strokeStyle = "#c084fc";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      if (!isExit) {
        ctx.fillStyle = "#c084fc";
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#d8b4fe";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, pos.x, pos.y - 12);
      recordLabelBox(label, pos.x, pos.y - 12, "portal", portal.id);
      ctx.textAlign = "left";
      return pos;
    };
    let fromPos = null, toPos = null;
    if (portal.from.world === state.viewedWorld) {
      fromPos = drawPortalMark(portal.from, portal.name, false);
    }
    if (portal.to.world === state.viewedWorld) {
      toPos = drawPortalMark(portal.to, t("portal_exit_prefix") + portal.name, true);
    }
    if (fromPos && toPos) {
      ctx.strokeStyle = "rgba(192, 132, 252, 0.5)";
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(fromPos.x, fromPos.y);
      ctx.lineTo(toPos.x, toPos.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Вейпоинты (мир просмотра)
  for (const wp of state.waypoints) {
    const point = worldToImage(tf, wp.x, wp.y);
    const pos = imageToScreen(point.x, point.y);
    ctx.fillStyle = "#ff59d9";
    ctx.strokeStyle = "#0d1117";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y - 8);
    ctx.lineTo(pos.x + 6, pos.y);
    ctx.lineTo(pos.x, pos.y + 8);
    ctx.lineTo(pos.x - 6, pos.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ff9dea";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(wp.name, pos.x, pos.y - 12);
    recordLabelBox(wp.name, pos.x, pos.y - 12, "wp", wp.id);
    ctx.textAlign = "left";
  }

  // Торговцы: жёлтая монета + подпись (наведи — покажет, чем торгует)
  for (const tr of state.traders) {
    const point = worldToImage(tf, tr.x, tr.y);
    const pos = imageToScreen(point.x, point.y);
    ctx.fillStyle = "#facc15";
    ctx.strokeStyle = "#0d1117";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#0d1117";
    ctx.font = "bold 10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("$", pos.x, pos.y + 3.5);
    ctx.fillStyle = "#fde68a";
    ctx.font = "12px sans-serif";
    const trLabel = t("trader_label", { name: tr.name });
    ctx.fillText(trLabel, pos.x, pos.y - 12);
    recordLabelBox(trLabel, pos.x, pos.y - 12, "trader", tr.id);
    ctx.textAlign = "left";
  }

  // Игроки
  if (viewing) {
    for (const player of state.players) {
      const point = worldToImage(tf, player.x, player.y);
      const pos = imageToScreen(point.x, point.y);
      const color = player.isLocal ? "#3fb950" : "#58a6ff";
      const yawRad = player.yaw * Math.PI / 180;
      const angle = Math.atan2(Math.sin(yawRad), Math.cos(yawRad)); // оси совпадают с миром

      ctx.save();
      ctx.translate(pos.x, pos.y);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.strokeStyle = "#0d1117";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(10, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = "#e6edf3";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(player.name, pos.x, pos.y - 14);
      ctx.textAlign = "left";

      if (state.follow && player.isLocal) {
        state.camX = point.x - canvas.width / (2 * state.zoom);
        state.camY = point.y - canvas.height / (2 * state.zoom);
      }
    }
  }

  drawSelectionOverlay();

  const coordsEl = document.getElementById("coords");
  if (state.lastMouse) {
    coordsEl.textContent = t("coords", {
      x: (state.lastMouse.x / WORLD_SCALE / 100).toFixed(0),
      y: (state.lastMouse.y / WORLD_SCALE / 100).toFixed(0),
      zoom: state.zoom.toFixed(2),
    });
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// Подсветка выбранного элемента и связь между концами (порталы, тележки)
function drawSelectionOverlay() {
  const sel = state.selected;
  if (!sel.type) return;

  const ring = (sx, sy, r) => {
    ctx.strokeStyle = "#d4a017";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
  };

  if (sel.type === "portal") {
    const portal = state.portals.find(p => p.id === sel.id);
    if (!portal) return;
    const fromIn = portal.from.world === state.viewedWorld;
    const toIn = portal.to.world === state.viewedWorld;
    const fromPos = fromIn ? worldScreen(portal.from.x, portal.from.y) : null;
    const toPos = toIn ? worldScreen(portal.to.x, portal.to.y) : null;
    // Яркая линия связи между входом и выходом
    if (fromPos && toPos) {
      ctx.strokeStyle = "#d4a017";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(fromPos.x, fromPos.y);
      ctx.lineTo(toPos.x, toPos.y);
      ctx.stroke();
    }
    if (fromPos) ring(fromPos.x, fromPos.y, 12);
    if (toPos) ring(toPos.x, toPos.y, 12);
    // Связь ведёт в другой мир — подсказываем стрелкой с ярлыком
    const visible = fromPos || toPos;
    const otherWorld = fromPos ? (toIn ? null : portal.to.world) : portal.from.world;
    if (visible && otherWorld) {
      ctx.fillStyle = "#d4a017";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("→ " + otherWorld, visible.x, visible.y + 26);
      ctx.textAlign = "left";
    }
  } else if (sel.type === "cart") {
    const cart = state.carts.find(c => c.id === sel.id);
    if (!cart) return;
    // Яркая подсветка всего пути (связь между станциями) + концы
    ctx.strokeStyle = "#d4a017";
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.beginPath();
    cart.path.forEach((p, i) => {
      const s = worldScreen(p[0], p[1]);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();
    for (const idx of [0, cart.path.length - 1]) {
      const s = worldScreen(cart.path[idx][0], cart.path[idx][1]);
      ring(s.x, s.y, 9);
    }
  } else {
    // Точка / лифт / зона — кольцо вокруг маркера
    const lists = {
      wp: state.waypoints, elevator: state.elevators, zone: state.portalIgnore,
      trader: state.traders,
    };
    const item = (lists[sel.type] || []).find(e => e.id === sel.id);
    if (!item) return;
    const s = worldScreen(item.x, item.y);
    ring(s.x, s.y, 13);
  }
}

// ==================== Мышь ====================

let dragging = false;
let dragStart = null;
let dragMoved = false;

function disableFollow() {
  state.follow = false;
  document.getElementById("followToggle").checked = false;
}

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  dragMoved = false;
  dragStart = { x: e.offsetX, y: e.offsetY, camX: state.camX, camY: state.camY };
});

window.addEventListener("mouseup", () => { dragging = false; });

canvas.addEventListener("mousemove", (e) => {
  state.lastMouse = screenToImage(e.offsetX, e.offsetY);
  if (dragging && dragStart) {
    state.camX = dragStart.camX - (e.offsetX - dragStart.x) / state.zoom;
    state.camY = dragStart.camY - (e.offsetY - dragStart.y) / state.zoom;
    if (Math.abs(e.offsetX - dragStart.x) + Math.abs(e.offsetY - dragStart.y) > 3) {
      dragMoved = true;
      disableFollow();
    }
  }
});

// Клик без перетаскивания = выбор элемента карты
canvas.addEventListener("click", (e) => {
  if (!dragMoved) handleMapClick(e.offsetX, e.offsetY);
});

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const before = screenToImage(e.offsetX, e.offsetY);
  state.zoom = Math.min(20, Math.max(0.02, state.zoom * factor));
  const after = screenToImage(e.offsetX, e.offsetY);
  state.camX += before.x - after.x;
  state.camY += before.y - after.y;
}, { passive: false });

// ==================== Тач (телефон) ====================

let touchState = null; // {mode: "pan"|"pinch", ...}

function touchPoint(touch) {
  const rect = canvas.getBoundingClientRect();
  return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
}

let tapStart = null; // {x, y, t} для распознавания тапа (не свайпа)

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    const p = touchPoint(e.touches[0]);
    touchState = { mode: "pan", x: p.x, y: p.y };
    tapStart = { x: p.x, y: p.y };
  } else if (e.touches.length === 2) {
    tapStart = null;
    const p1 = touchPoint(e.touches[0]), p2 = touchPoint(e.touches[1]);
    touchState = {
      mode: "pinch",
      dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    };
  }
}, { passive: false });

canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  if (!touchState) return;
  if (touchState.mode === "pan" && e.touches.length === 1) {
    const p = touchPoint(e.touches[0]);
    if (tapStart && Math.hypot(p.x - tapStart.x, p.y - tapStart.y) > 8) tapStart = null;
    state.camX -= (p.x - touchState.x) / state.zoom;
    state.camY -= (p.y - touchState.y) / state.zoom;
    touchState.x = p.x;
    touchState.y = p.y;
    disableFollow();
  } else if (touchState.mode === "pinch" && e.touches.length === 2) {
    const p1 = touchPoint(e.touches[0]), p2 = touchPoint(e.touches[1]);
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const before = screenToImage(mid.x, mid.y);
    state.zoom = Math.min(20, Math.max(0.02, state.zoom * dist / touchState.dist));
    const after = screenToImage(mid.x, mid.y);
    state.camX += before.x - after.x;
    state.camY += before.y - after.y;
    state.camX -= (mid.x - touchState.mid.x) / state.zoom;
    state.camY -= (mid.y - touchState.mid.y) / state.zoom;
    touchState.dist = dist;
    touchState.mid = mid;
    disableFollow();
  }
}, { passive: false });

canvas.addEventListener("touchend", (e) => {
  if (e.touches.length === 0) {
    touchState = null;
    if (tapStart) { handleMapClick(tapStart.x, tapStart.y); tapStart = null; }
  }
}, { passive: false });

// ==================== 3D-вид ====================

const canvas3d = document.getElementById("map3d");
let view3dReady = false;
let view3dCentered = false;

function rebuildCloud() {
  if (!view3dReady) return;
  // Режим «этаж»: только вокселя в ±5 м от высоты игрока — иначе при
  // миллионах точек 3D превращается в нечитаемую кашу
  const refZ = (state.world === state.viewedWorld) ? state.scan.refZ : null;
  const filter = state.floor3d && refZ !== null;
  const zLo = filter ? Math.floor((refZ - 500) / SCAN_CELL) : -Infinity;
  const zHi = filter ? Math.ceil((refZ + 500) / SCAN_CELL) : Infinity;
  const cells = [];
  for (const col of state.scan.columns.values()) {
    for (const gz of col.zs.keys()) {
      if (gz < zLo || gz > zHi) continue;
      cells.push({ gx: col.gx, gy: col.gy, gz });
    }
  }
  View3D.setCloud(cells);
  state.scan.dirty3d = false;
}

const floor3dBtn = document.getElementById("floor3dBtn");

function updateFloor3dBtn() {
  floor3dBtn.textContent = state.floor3d ? t("floor3d_floor") : t("floor3d_all");
  floor3dBtn.title = t("floor3d_title");
  floor3dBtn.classList.toggle("active", state.floor3d);
}
updateFloor3dBtn();

floor3dBtn.addEventListener("click", () => {
  state.floor3d = !state.floor3d;
  state.scan.dirty3d = true;
  updateFloor3dBtn();
  if (state.view3d) rebuildCloud();
});

document.getElementById("view3dBtn").addEventListener("click", () => {
  if (!view3dReady) {
    try {
      view3dReady = View3D.init(canvas3d, document.getElementById("hud3d"));
    } catch (err) {
      alert(t("webgl_error") + err.message);
      return;
    }
    if (!view3dReady) {
      alert(t("webgl_unavailable"));
      return;
    }
  }
  state.view3d = !state.view3d;
  canvas3d.classList.toggle("hidden", !state.view3d);
  document.getElementById("hud3d").classList.toggle("hidden", !state.view3d);
  canvas.classList.toggle("hidden", state.view3d);
  document.getElementById("view3dBtn").classList.toggle("active", state.view3d);
  floor3dBtn.classList.toggle("hidden", !state.view3d);
  if (state.view3d) {
    rebuildCloud();
    syncView3dMarkers();
    if (state.route.points.length > 0) View3D.setRoute(state.route.points);
    updateSelection3d();
    const local = state.players.find(p => p.isLocal) || state.players[0];
    if (local && !view3dCentered) {
      View3D.centerOn(local.x, local.y, local.z);
      view3dCentered = true;
    }
    View3D.start();
  } else {
    View3D.stop();
  }
});

// ==================== Controls ====================

document.getElementById("worldSelect").addEventListener("change", (e) => {
  switchViewedWorld(e.target.value);
});

// Language selector
(() => {
  const sel = document.getElementById("langSelect");
  if (sel) {
    sel.value = I18N.lang;
    sel.addEventListener("change", (e) => I18N.setLang(e.target.value));
  }
})();

document.getElementById("followToggle").addEventListener("change", (e) => {
  state.follow = e.target.checked;
});

document.getElementById("trailToggle").addEventListener("change", (e) => {
  state.showTrail = e.target.checked;
  if (!e.target.checked) state.trails.clear();
});

document.getElementById("addWaypointBtn").addEventListener("click", async () => {
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert(t("no_player_data"));
    return;
  }
  const name = prompt(t("waypoint_prompt"), "");
  if (!name) return;
  if (state.viewedWorld !== state.world) switchViewedWorld(state.world);
  await addWaypoint(name.trim(), local.x, local.y, local.z);
  positionWaypointPanel();
  document.getElementById("waypointPanel").classList.remove("hidden");
});

// On phones the topbar wraps to 2-3 rows — place the panel right below it
function positionWaypointPanel() {
  const bar = document.getElementById("topbar");
  document.getElementById("waypointPanel").style.top = (bar.offsetHeight + 8) + "px";
}
window.addEventListener("resize", positionWaypointPanel);

document.getElementById("waypointsBtn").addEventListener("click", () => {
  positionWaypointPanel();
  document.getElementById("waypointPanel").classList.toggle("hidden");
});

// ---- «+ Торговец»: сохраняет того, рядом с кем ты стоишь ----
document.getElementById("addTraderBtn").addEventListener("click", () => {
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert(t("no_player_data"));
    return;
  }
  const select = document.getElementById("traderPickSelect");
  select.innerHTML = "";
  const catalog = (state.traderCatalog && state.traderCatalog.traders) || [];
  for (const entry of catalog) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.location ? `${entry.name} — ${entry.location}` : entry.name;
    select.appendChild(option);
  }
  document.getElementById("traderPickPopup").classList.remove("hidden");
});

document.getElementById("traderPickCancel").addEventListener("click", () => {
  document.getElementById("traderPickPopup").classList.add("hidden");
});

document.getElementById("traderPickAdd").addEventListener("click", async () => {
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local) return;
  const key = document.getElementById("traderPickSelect").value;
  const entry = catalogEntry(key);
  document.getElementById("traderPickPopup").classList.add("hidden");
  if (state.viewedWorld !== state.world) switchViewedWorld(state.world);
  await addTrader(key, entry ? entry.name : key, local.x, local.y, local.z);
  positionWaypointPanel();
  document.getElementById("waypointPanel").classList.remove("hidden");
});

// ---- Наведение: курсор-указатель над кликабельным, тултип торговца ----
canvas.addEventListener("mousemove", (e) => {
  if (state.view3d) return;
  if (dragging) {
    canvas.style.cursor = "grabbing";
    return;
  }
  const hit = hitTestMap(e.offsetX, e.offsetY);
  state.hover = hit;
  canvas.style.cursor = hit ? "pointer" : "";
  const tr = traderAt(e.offsetX, e.offsetY);
  if (tr) showTraderTooltip(tr, e.clientX, e.clientY);
  else hideTraderTooltip();
});
canvas.addEventListener("mouseleave", () => {
  hideTraderTooltip();
  state.hover = null;
  canvas.style.cursor = "";
});

document.getElementById("noPortalBtn").addEventListener("click", async () => {
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert(t("no_player_base"));
    return;
  }
  const name = prompt(t("zone_name_prompt"), t("zone_default_name"));
  if (name === null) return;
  const radiusMeters = parseFloat(prompt(t("zone_radius_prompt"), "15") || "0");
  if (!radiusMeters || radiusMeters <= 0) return;
  await addPortalIgnoreZone((name || t("zone_default_name")).trim(), radiusMeters * 100, local.x, local.y, local.z);
});

document.getElementById("elevatorBtn").addEventListener("click", () => {
  if (state.elevatorRec) {
    finishElevatorRecording();
    return;
  }
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert(t("no_player_data"));
    return;
  }
  state.elevatorRec = { samples: [] };
  const btn = document.getElementById("elevatorBtn");
  btn.classList.add("recording");
  btn.textContent = t("elevator_btn_stop_zero");
});

document.getElementById("cartBtn").addEventListener("click", () => {
  if (state.cartRec) {
    finishCartRecording();
    return;
  }
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert(t("no_player_data"));
    return;
  }
  state.cartRec = { samples: [] };
  const btn = document.getElementById("cartBtn");
  btn.classList.add("recording");
  btn.textContent = t("cart_btn_stop_zero");
});

// ==================== Notes (shared notepad, PC/phone sync) ====================

const notesText = document.getElementById("notesText");
const notesStatus = document.getElementById("notesStatus");
let notesServerText = null;   // last known text on the server
let notesSaveTimer = null;

async function loadNotes() {
  try {
    const data = await (await fetch("/api/notes")).json();
    notesServerText = data.text;
    notesText.value = data.text;
    notesStatus.textContent = t("notes_synced");
  } catch (err) {
    notesStatus.textContent = t("notes_server_down");
  }
}

async function saveNotes() {
  const text = notesText.value;
  notesStatus.textContent = t("notes_saving");
  try {
    const resp = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (resp.ok) {
      notesServerText = text;
      notesStatus.textContent = t("notes_saved");
    } else {
      notesStatus.textContent = t("notes_save_error");
    }
  } catch (err) {
    notesStatus.textContent = t("notes_not_saved");
  }
}

notesText.addEventListener("input", () => {
  notesStatus.textContent = t("notes_typing");
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotes, 800);
});

// Pull other devices' edits (e.g. from the phone) without disturbing typing
async function pollNotes() {
  try {
    const popupOpen = !document.getElementById("notesPopup").classList.contains("hidden");
    if (popupOpen && notesServerText !== null) {
      const data = await (await fetch("/api/notes")).json();
      const localDirty = notesText.value !== notesServerText;
      if (data.text !== notesServerText && !localDirty && document.activeElement !== notesText) {
        notesServerText = data.text;
        notesText.value = data.text;
        notesStatus.textContent = t("notes_updated");
      }
    }
  } catch (err) { /* try again next time */ }
  setTimeout(pollNotes, 5000);
}

document.getElementById("notesBtn").addEventListener("click", async () => {
  const popup = document.getElementById("notesPopup");
  popup.classList.toggle("hidden");
  if (!popup.classList.contains("hidden")) await loadNotes();
});

document.getElementById("notesClose").addEventListener("click", () => {
  clearTimeout(notesSaveTimer);
  if (notesText.value !== notesServerText) saveNotes();
  document.getElementById("notesPopup").classList.add("hidden");
});

pollNotes();

// ==================== Попап с картинками секторов ====================

async function initImagesPopup() {
  try {
    const resp = await fetch("/api/maps");
    const config = await resp.json();
    const select = document.getElementById("imageSelect");
    select.innerHTML = "";
    for (const map of config.maps || []) {
      if (!map.image || map.virtual || map.id === "placeholder") continue;
      const option = document.createElement("option");
      option.value = map.image;
      option.textContent = map.name;
      select.appendChild(option);
    }
    select.addEventListener("change", () => {
      document.getElementById("imageView").src = "/maps/" + select.value;
    });
  } catch (err) { /* server unavailable */ }
}

document.getElementById("imagesBtn").addEventListener("click", () => {
  const popup = document.getElementById("imagesPopup");
  popup.classList.remove("hidden");
  const select = document.getElementById("imageSelect");
  if (select.value) document.getElementById("imageView").src = "/maps/" + select.value;
});

document.getElementById("imagesClose").addEventListener("click", () => {
  document.getElementById("imagesPopup").classList.add("hidden");
});

// ==================== Startup ====================

I18N.applyStatic();
loadTraderCatalog().then(pollTraders);
loadWorlds();
connectStream();
pollScan();
pollWalked();
initImagesPopup();
