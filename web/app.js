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
    cells: new Map(),      // "gx:gy:gz" -> {gx, gy, gz, count}
    version: 0,
    world: null,           // мир, для которого загружены ячейки
    canvas: null,          // offscreen-канвас видимого региона
    origin: { x: 0, y: 0 },// позиция канваса в px карты
    scale: 1,              // px канваса на px карты (при больших регионах < 1)
    view: null,            // {x0,y0,x1,y1} px карты — регион, для которого построен канвас
    dirty: false,
    dirty3d: false,
    refZ: null,            // опорная высота (z игрока, см) для цветов и выбора вокселя
  },
  view3d: false,
  walked: new Set(),       // "gx:gy:gz" — где игрок физически прошёл (двери и т.п.)
  walkedVersion: 0,
  waypoints: [],
  elevators: [],           // [{id, name, world, x, y, radius, doors, stops:[z...]}]
  elevatorRec: null,       // null | {samples: [{x, y, z, t}]} — идёт запись лифта
  carts: [],               // [{id, name, world, path: [[x,y,z]...]}] — тележки/рельсы
  cartRec: null,           // null | {samples: [{x, y, z, t}]} — идёт запись тележки
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
  } catch (err) { /* сервер недоступен */ }
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
    option.textContent = world + (world === state.world ? " (тут игрок)" : "");
    select.appendChild(option);
  }
  if (state.viewedWorld) select.value = state.viewedWorld;
}

function switchViewedWorld(world) {
  if (!world || state.viewedWorld === world) return;
  state.viewedWorld = world;
  state.centered = false;
  state.trails.clear();
  state.scan.cells.clear();
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
}

// ==================== Скан ====================

async function pollScan() {
  try {
    if (!state.viewedWorld) return;
    if (state.scan.world !== state.viewedWorld) {
      state.scan.cells.clear();
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
      state.scan.cells.clear();
      state.scan.version = 0;
      state.scan.dirty = true;
      state.scan.dirty3d = true;
      return;
    }
    state.scan.epoch = payload.epoch;
    if (payload.cells.length > 0) {
      for (const [gx, gy, gz, count] of payload.cells) {
        const key = `${gx}:${gy}:${gz}`;
        if (count > 0) {
          state.scan.cells.set(key, { gx, gy, gz, count });
        } else {
          state.scan.cells.delete(key); // надгробие: воксель стёрт карвингом
        }
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
// На колонку берётся воксель, ближайший по высоте к игроку, — карта видна
// на любом удалении и высоте, а перепады читаются цветом.
function rebuildScanCanvas() {
  state.scan.dirty = false;
  state.scan.canvas = null;

  // Регион: вьюпорт + запас в полэкрана со всех сторон
  const vw = canvas.width / state.zoom;
  const vh = canvas.height / state.zoom;
  const x0 = state.camX - vw * 0.5;
  const y0 = state.camY - vh * 0.5;
  const x1 = state.camX + vw * 1.5;
  const y1 = state.camY + vh * 1.5;
  state.scan.view = { x0, y0, x1, y1 };

  if (state.scan.cells.size === 0) return;

  const viewing = state.world === state.viewedWorld;
  const refZ = (viewing && state.scan.refZ !== null) ? state.scan.refZ : null;
  const pxPerCell = SCAN_CELL * WORLD_SCALE;

  // Лучший воксель на колонку в регионе
  const best = new Map(); // "gx:gy" -> cell
  for (const cell of state.scan.cells.values()) {
    const px = (cell.gx + 0.5) * pxPerCell;
    const py = (cell.gy + 0.5) * pxPerCell;
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    const key = `${cell.gx}:${cell.gy}`;
    const current = best.get(key);
    if (!current) {
      best.set(key, cell);
    } else if (refZ !== null &&
               Math.abs(cell.gz * SCAN_CELL - refZ) < Math.abs(current.gz * SCAN_CELL - refZ)) {
      best.set(key, cell);
    }
  }
  if (best.size === 0) return;

  // Канвас региона; при большом регионе рисуем в уменьшенном масштабе
  const regionW = Math.ceil(x1 - x0);
  const regionH = Math.ceil(y1 - y0);
  const scale = Math.min(1, 4096 / regionW, 4096 / regionH);
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.ceil(regionW * scale));
  off.height = Math.max(1, Math.ceil(regionH * scale));
  const octx = off.getContext("2d");

  // Группируем по цветовым корзинам, чтобы не переключать fillStyle на каждую клетку
  const buckets = SCAN_BUCKET_COLORS.map(() => []);
  for (const cell of best.values()) {
    const bucket = refZ === null ? 3 : scanBucket(cell.gz * SCAN_CELL - refZ);
    buckets[bucket].push(cell);
  }
  const cellPx = Math.max(1.2, pxPerCell * scale);
  for (let b = 0; b < buckets.length; b++) {
    if (buckets[b].length === 0) continue;
    octx.fillStyle = SCAN_BUCKET_COLORS[b];
    for (const cell of buckets[b]) {
      const px = ((cell.gx + 0.5) * pxPerCell - x0) * scale;
      const py = ((cell.gy + 0.5) * pxPerCell - y0) * scale;
      octx.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
    }
  }

  state.scan.canvas = off;
  state.scan.origin = { x: x0, y: y0 };
  state.scan.scale = scale;
}

// Вьюпорт вышел за построенный регион — нужен новый канвас
function scanRegionStale() {
  const view = state.scan.view;
  if (!view) return true;
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
      markers.push({ x: portal.to.x, y: portal.to.y, z: portal.to.z, name: "◎ выход: " + portal.name });
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
  } catch (err) { /* сервер недоступен */ }
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
  const btn = makeButton(isActive ? "Стоп" : (label || "Маршрут"),
    () => startRouteTo(pseudoId, name, world, x, y, z),
    "Построить маршрут");
  if (isActive) btn.className = "wp-active";
  return btn;
}

function makeRenameButton(endpoint, id, oldName, reload) {
  return makeButton("✎", async () => {
    const name = prompt("Новое название:", oldName);
    if (name === null || !name.trim()) return;
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", id, name: name.trim() }),
    });
    if (!resp.ok) {
      alert("Сервер не принял переименование — перезапусти server.py (у тебя старая версия).");
      return;
    }
    await reload();
  }, "Переименовать");
}

function makeRow(list, labelText, jumpPos, buttons) {
  const row = document.createElement("div");
  row.className = "wp-row";
  const name = document.createElement("span");
  name.className = "wp-name";
  name.title = "Показать на карте";
  name.textContent = labelText;
  name.onclick = () => jumpTo(jumpPos.x, jumpPos.y, jumpPos.z);
  row.appendChild(name);
  for (const btn of buttons) row.appendChild(btn);
  list.appendChild(row);
}

function renderWaypointList() {
  const list = document.getElementById("waypointList");
  list.innerHTML = "";
  if (state.waypoints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wp-name";
    empty.textContent = "Точек в этом мире нет. «+ Точка» ставит точку там, где ты стоишь.";
    list.appendChild(empty);
  }

  for (const wp of state.waypoints) {
    makeRow(list, wp.name, wp, [
      makeRenameButton("/api/waypoints", wp.id, wp.name, loadWaypoints),
      makeRouteButton(wp.id, wp.name, wp.world, wp.x, wp.y, wp.z),
      makeButton("×", () => {
        if (confirm(`Удалить точку «${wp.name}»?`)) deleteWaypoint(wp.id);
      }, "Удалить"),
    ]);
  }

  for (const elevator of state.elevators) {
    makeRow(list,
      `⬍ ${elevator.name} (${elevator.stops.length} эт.${elevator.doors ? ", двери" : ""})`,
      { x: elevator.x, y: elevator.y, z: elevator.stops[0] },
      [
        makeRenameButton("/api/elevators", elevator.id, elevator.name, loadElevators),
        makeButton("×", () => {
          if (confirm(`Удалить «${elevator.name}»? Зона снова начнёт сканироваться.`)) deleteElevator(elevator.id);
        }, "Удалить"),
      ]);
  }

  for (const portal of state.portals) {
    const crossWorld = portal.from.world !== portal.to.world;
    const anchor = portal.from.world === state.viewedWorld ? portal.from : portal.to;
    makeRow(list,
      `◎ ${portal.name}${crossWorld ? ` (${portal.from.world} → ${portal.to.world})` : ""} ×${portal.count}`,
      anchor,
      [
        makeRenameButton("/api/portals", portal.id, portal.name, loadPortals),
        makeRouteButton(`portal:${portal.id}`, portal.name, anchor.world, anchor.x, anchor.y, anchor.z),
        makeButton("×", () => {
          if (confirm(`Удалить «${portal.name}»? (ложные срабатывания — например, после смерти — удаляй смело)`)) deletePortal(portal.id);
        }, "Удалить"),
      ]);
  }

  for (const zone of state.portalIgnore) {
    makeRow(list,
      `🚫 ${zone.name} (не портал, ${(zone.radius / 100).toFixed(0)} м)`,
      zone,
      [
        makeRenameButton("/api/portals", zone.id, zone.name, loadPortals),
        makeButton("×", () => {
          if (confirm(`Удалить зону «${zone.name}»? Телепорты сюда снова начнут записываться как порталы.`)) {
            deletePortalIgnoreZone(zone.id);
          }
        }, "Удалить"),
      ]);
  }

  for (const cart of state.carts) {
    const first = cart.path[0];
    const last = cart.path[cart.path.length - 1];
    makeRow(list,
      `⛟ ${cart.name} (${cartLengthMeters(cart).toFixed(0)} м)`,
      { x: first[0], y: first[1], z: first[2] },
      [
        makeRenameButton("/api/carts", cart.id, cart.name, loadCarts),
        makeRouteButton(`cart:${cart.id}:a`, `${cart.name} (начало)`, cart.world, first[0], first[1], first[2], "▶А"),
        makeRouteButton(`cart:${cart.id}:b`, `${cart.name} (конец)`, cart.world, last[0], last[1], last[2], "▶Б"),
        makeButton("×", () => {
          if (confirm(`Удалить «${cart.name}»?`)) deleteCart(cart.id);
        }, "Удалить"),
      ]);
  }
}

// ==================== Лифты ====================

async function loadElevators() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/elevators${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.elevators = (await resp.json()).elevators || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* сервер недоступен */ }
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
  } catch (err) { /* сервер недоступен */ }
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

// ==================== Тележки (рельсовый транспорт) ====================

async function loadCarts() {
  try {
    const world = state.viewedWorld;
    const resp = await fetch(`/api/carts${world ? "?world=" + encodeURIComponent(world) : ""}`);
    state.carts = (await resp.json()).carts || [];
    renderWaypointList();
    syncView3dMarkers();
  } catch (err) { /* сервер недоступен */ }
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
  btn.textContent = "Тележка";

  // Прореживаем путь: точка каждые >= 1.5 м
  const path = [];
  for (const s of samples) {
    const last = path[path.length - 1];
    if (!last || Math.hypot(s.x - last[0], s.y - last[1], s.z - last[2]) >= 150) {
      path.push([Math.round(s.x), Math.round(s.y), Math.round(s.z)]);
    }
  }
  const length = path.length >= 2 ? cartLengthMeters({ path }) : 0;
  if (path.length < 3 || length < 10) {
    alert("Слишком короткая запись — сядь в тележку, нажми «Тележка», доедь до конца и нажми ещё раз.");
    return;
  }
  const name = prompt(`Маршрут тележки: ${length.toFixed(0)} м. Название:`, `Тележка ${state.carts.length + 1}`);
  if (name === null) return;

  const resp = await fetch("/api/carts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "add", name: (name || "Тележка").trim(), world: state.world, path }),
  });
  if (resp.ok) {
    await loadCarts();
    state.route.lastCalc = 0;
  } else {
    alert("Не удалось сохранить: " + (await resp.text()));
  }
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
  } catch (err) { /* сервер недоступен */ }
}

function inPortalIgnoreZone(world, x, y, z) {
  return state.portalIgnore.some(zone =>
    zone.world === world && Math.hypot(x - zone.x, y - zone.y, z - zone.z) < zone.radius);
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
    alert(`Зона «${name}» создана (${(radius / 100).toFixed(0)} м). Удалено старых порталов: ${result.purgedPortals}.`);
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
  const name = crossWorld ? `Портал → ${to.world}` : "Портал";
  try {
    const resp = await fetch("/api/portals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "add", name, from, to }),
    });
    if (resp.ok) {
      const result = await resp.json();
      if (!result.duplicate) {
        console.info("Обнаружен новый портал:", result.portal);
      }
      await loadPortals();
      state.route.lastCalc = 0;
    }
  } catch (err) { /* сервер недоступен */ }
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
  document.getElementById("elevatorBtn").textContent = "Лифт";

  if (samples.length < 10) {
    alert("Слишком короткая запись — встань в лифт, нажми «Лифт», прокатись по всем этажам и нажми ещё раз.");
    return;
  }
  const stops = detectElevatorStops(samples);
  if (stops.length < 2) {
    alert(`Найдена только ${stops.length} остановка. Прокатись по всем этажам, задерживаясь на каждом хотя бы пару секунд.`);
    return;
  }
  // Центр и радиус зоны — по горизонтальному разбросу записи
  const cx = samples.reduce((s, p) => s + p.x, 0) / samples.length;
  const cy = samples.reduce((s, p) => s + p.y, 0) / samples.length;
  const spread = Math.max(...samples.map(p => Math.hypot(p.x - cx, p.y - cy)));
  if (spread > 700) {
    alert("Во время записи ты уходил далеко от лифта — запись отменена. Оставайся в кабине.");
    return;
  }
  const name = prompt(`Лифт с ${stops.length} остановками. Название:`, `Лифт ${state.elevators.length + 1}`);
  if (name === null) return;
  // У лифта с дверями зона шире: двери в скане — «мерцающая» стена, их тоже исключаем
  const doors = confirm("У этого лифта есть закрывающиеся двери?\nОК — да, Отмена — открытая платформа.");

  const resp = await fetch("/api/elevators", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "add",
      name: (name || "Лифт").trim(),
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
    alert(`Лифт сохранён: ${stops.length} остановок. Вычищено ${result.purgedCells} мусорных ячеек скана.`);
  } else {
    alert("Не удалось сохранить лифт: " + (await resp.text()));
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
  const has = key => state.scan.cells.has(key);
  const columns = new Map(); // "gx:gy" -> [gz пола, ...]
  for (const cell of state.scan.cells.values()) {
    if (has(`${cell.gx}:${cell.gy}:${cell.gz + 1}`) ||
        has(`${cell.gx}:${cell.gy}:${cell.gz + 2}`) ||
        has(`${cell.gx}:${cell.gy}:${cell.gz + 3}`)) continue;
    const columnKey = `${cell.gx}:${cell.gy}`;
    let floors = columns.get(columnKey);
    if (!floors) { floors = []; columns.set(columnKey, floors); }
    floors.push(cell.gz);
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
    statusEl.textContent = "Маршрут доступен, когда смотришь мир, где находится игрок.";
    return;
  }
  const now = Date.now();
  if (now - state.route.lastCalc < 3000) return;
  state.route.lastCalc = now;

  let target = state.route.target;
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!target || !local) return;

  // Точка в другом мире: ведём к входу портала, который туда телепортирует
  let portalHint = "";
  if (target.world && target.world !== state.world) {
    const gate = state.portals.find(
      p => p.from.world === state.world && p.to.world === target.world);
    if (!gate) {
      state.route.points = [];
      state.route.status = `Точка в мире «${target.world}», известного портала туда нет — пройди через него один раз.`;
      statusEl.textContent = state.route.status;
      if (view3dReady) View3D.clearRoute();
      return;
    }
    portalHint = ` → дальше через «${gate.name}»`;
    target = { name: target.name, x: gate.from.x, y: gate.from.y, z: gate.from.z };
  }

  const columns = buildFloorIndex();
  const start = nearestFloorNode(columns, local.x, local.y, local.z);
  const goal = nearestFloorNode(columns, target.x, target.y, target.z);
  if (!start || !goal) {
    state.route.points = [];
    state.route.status = "Рядом нет отсканированного пола — осмотрись вокруг.";
    statusEl.textContent = state.route.status;
    if (view3dReady) View3D.clearRoute();
    return;
  }

  const path = findPath(columns, start, goal, buildSpecialEdges(columns));
  if (!path) {
    state.route.points = [];
    state.route.status = "Путь не найден: маршрут ещё не отсканирован. Пройди и осмотри дорогу один раз.";
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
  state.route.status = `Маршрут до «${target.name}»: ${lengthMeters.toFixed(0)} м${portalHint}`;
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
    statusEl.textContent = "подключено";
    statusEl.className = "status-ok";
  };

  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.state) return;
    state.players = payload.state.players || [];
    state.world = payload.state.world || "";

    // Автопереключение на мир игрока при его смене
    if (state.world !== lastPlayerWorld) {
      lastPlayerWorld = state.world;
      if (state.world && state.world !== "MainMenu") {
        switchViewedWorld(state.world);
        loadWorlds();
      }
      renderWorldSelect();
    }

    const viewing = state.viewedWorld === state.world;
    statusEl.textContent = `онлайн: ${state.players.length} | мир: ${state.world}`
      + (viewing ? "" : ` | просмотр: ${state.viewedWorld}`);
    statusEl.className = "status-ok";

    if (viewing) updateTrails();

    const local = state.players.find(p => p.isLocal) || state.players[0];
    if (local) detectPortal(local);
    // Запись лифта: копим позиции игрока
    if (state.elevatorRec && local) {
      state.elevatorRec.samples.push({ x: local.x, y: local.y, z: local.z, t: Date.now() });
      document.getElementById("elevatorBtn").textContent =
        `Стоп (${detectElevatorStops(state.elevatorRec.samples).length} ост.)`;
    }
    // Запись тележки: копим путь
    if (state.cartRec && local) {
      state.cartRec.samples.push({ x: local.x, y: local.y, z: local.z, t: Date.now() });
      const first = state.cartRec.samples[0];
      const dist = Math.hypot(local.x - first.x, local.y - first.y, local.z - first.z) / 100;
      document.getElementById("cartBtn").textContent = `Стоп (${dist.toFixed(0)} м)`;
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
    statusEl.textContent = "нет связи с сервером…";
    statusEl.className = "status-err";
  };
}

function updateTrails() {
  const t = currentTransform();
  const alive = new Set();
  for (const player of state.players) {
    alive.add(player.id);
    const point = worldToImage(t, player.x, player.y);
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

  const t = currentTransform();
  const viewing = state.viewedWorld === state.world;

  // Скан
  if (state.scan.dirty || scanRegionStale()) rebuildScanCanvas();
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
    const startPoint = worldToImage(t, state.route.points[0].x, state.route.points[0].y);
    const startScreen = imageToScreen(startPoint.x, startPoint.y);
    ctx.moveTo(startScreen.x, startScreen.y);
    for (let i = 1; i < state.route.points.length; i++) {
      const point = worldToImage(t, state.route.points[i].x, state.route.points[i].y);
      const screen = imageToScreen(point.x, point.y);
      ctx.lineTo(screen.x, screen.y);
    }
    ctx.stroke();
  }

  // Лифты: круг зоны + символ
  for (const elevator of state.elevators) {
    const point = worldToImage(t, elevator.x, elevator.y);
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
    ctx.fillText(`${elevator.name} (${elevator.stops.length} эт.)`, pos.x, pos.y - Math.max(6, radius) - 4);
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
      const point = worldToImage(t, p[0], p[1]);
      const pos = imageToScreen(point.x, point.y);
      if (!started) { ctx.moveTo(pos.x, pos.y); started = true; }
      else ctx.lineTo(pos.x, pos.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    for (const idx of [0, cart.path.length - 1]) {
      const point = worldToImage(t, cart.path[idx][0], cart.path[idx][1]);
      const pos = imageToScreen(point.x, point.y);
      ctx.fillStyle = "#4ade80";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    const mid = cart.path[Math.floor(cart.path.length / 2)];
    const midPoint = worldToImage(t, mid[0], mid[1]);
    const midPos = imageToScreen(midPoint.x, midPoint.y);
    ctx.fillStyle = "#86efac";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`⛟ ${cart.name}`, midPos.x, midPos.y - 8);
    ctx.textAlign = "left";
  }

  // Зоны «не портал»: серый пунктирный круг
  for (const zone of state.portalIgnore) {
    const point = worldToImage(t, zone.x, zone.y);
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
    ctx.fillText(`🚫 ${zone.name}`, pos.x, pos.y - radius - 4);
    ctx.textAlign = "left";
  }

  // Порталы: вход ◎, выход ◌, для внутримировых — пунктир между ними
  for (const portal of state.portals) {
    const drawPortalMark = (p, label, isExit) => {
      const point = worldToImage(t, p.x, p.y);
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
      ctx.textAlign = "left";
      return pos;
    };
    let fromPos = null, toPos = null;
    if (portal.from.world === state.viewedWorld) {
      fromPos = drawPortalMark(portal.from, portal.name, false);
    }
    if (portal.to.world === state.viewedWorld) {
      toPos = drawPortalMark(portal.to, "выход: " + portal.name, true);
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
    const point = worldToImage(t, wp.x, wp.y);
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
    ctx.textAlign = "left";
  }

  // Игроки
  if (viewing) {
    for (const player of state.players) {
      const point = worldToImage(t, player.x, player.y);
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

  const coordsEl = document.getElementById("coords");
  if (state.lastMouse) {
    coordsEl.textContent = `${(state.lastMouse.x / WORLD_SCALE / 100).toFixed(0)}, ${(state.lastMouse.y / WORLD_SCALE / 100).toFixed(0)} м | zoom: ${state.zoom.toFixed(2)}`;
  }

  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// ==================== Мышь ====================

let dragging = false;
let dragStart = null;

function disableFollow() {
  state.follow = false;
  document.getElementById("followToggle").checked = false;
}

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  dragStart = { x: e.offsetX, y: e.offsetY, camX: state.camX, camY: state.camY };
});

window.addEventListener("mouseup", () => { dragging = false; });

canvas.addEventListener("mousemove", (e) => {
  state.lastMouse = screenToImage(e.offsetX, e.offsetY);
  if (dragging && dragStart) {
    state.camX = dragStart.camX - (e.offsetX - dragStart.x) / state.zoom;
    state.camY = dragStart.camY - (e.offsetY - dragStart.y) / state.zoom;
    if (Math.abs(e.offsetX - dragStart.x) + Math.abs(e.offsetY - dragStart.y) > 3) {
      disableFollow();
    }
  }
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

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    const p = touchPoint(e.touches[0]);
    touchState = { mode: "pan", x: p.x, y: p.y };
  } else if (e.touches.length === 2) {
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
  if (e.touches.length === 0) touchState = null;
}, { passive: false });

// ==================== 3D-вид ====================

const canvas3d = document.getElementById("map3d");
let view3dReady = false;
let view3dCentered = false;

function rebuildCloud() {
  if (!view3dReady) return;
  View3D.setCloud([...state.scan.cells.values()]);
  state.scan.dirty3d = false;
}

document.getElementById("view3dBtn").addEventListener("click", () => {
  if (!view3dReady) {
    try {
      view3dReady = View3D.init(canvas3d, document.getElementById("hud3d"));
    } catch (err) {
      alert("WebGL недоступен: " + err.message);
      return;
    }
    if (!view3dReady) {
      alert("WebGL недоступен в этом браузере.");
      return;
    }
  }
  state.view3d = !state.view3d;
  canvas3d.classList.toggle("hidden", !state.view3d);
  document.getElementById("hud3d").classList.toggle("hidden", !state.view3d);
  canvas.classList.toggle("hidden", state.view3d);
  document.getElementById("view3dBtn").classList.toggle("active", state.view3d);
  if (state.view3d) {
    rebuildCloud();
    syncView3dMarkers();
    if (state.route.points.length > 0) View3D.setRoute(state.route.points);
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

// ==================== Контролы ====================

document.getElementById("worldSelect").addEventListener("change", (e) => {
  switchViewedWorld(e.target.value);
});

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
    alert("Нет данных о позиции игрока — зайди в игру.");
    return;
  }
  const name = prompt("Название точки:", "");
  if (!name) return;
  if (state.viewedWorld !== state.world) switchViewedWorld(state.world);
  await addWaypoint(name.trim(), local.x, local.y, local.z);
  positionWaypointPanel();
  document.getElementById("waypointPanel").classList.remove("hidden");
});

// Топбар на телефоне переносится на 2-3 строки — панель ставим строго под него
function positionWaypointPanel() {
  const bar = document.getElementById("topbar");
  document.getElementById("waypointPanel").style.top = (bar.offsetHeight + 8) + "px";
}
window.addEventListener("resize", positionWaypointPanel);

document.getElementById("waypointsBtn").addEventListener("click", () => {
  positionWaypointPanel();
  document.getElementById("waypointPanel").classList.toggle("hidden");
});

document.getElementById("noPortalBtn").addEventListener("click", async () => {
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert("Нет данных о позиции игрока — зайди в игру и встань на базе.");
    return;
  }
  const name = prompt("Название зоны (например, «База»):", "База");
  if (name === null) return;
  const radiusMeters = parseFloat(prompt("Радиус зоны, м:", "15") || "0");
  if (!radiusMeters || radiusMeters <= 0) return;
  await addPortalIgnoreZone((name || "База").trim(), radiusMeters * 100, local.x, local.y, local.z);
});

document.getElementById("elevatorBtn").addEventListener("click", () => {
  if (state.elevatorRec) {
    finishElevatorRecording();
    return;
  }
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert("Нет данных о позиции игрока — зайди в игру.");
    return;
  }
  state.elevatorRec = { samples: [] };
  const btn = document.getElementById("elevatorBtn");
  btn.classList.add("recording");
  btn.textContent = "Стоп (0 ост.)";
});

document.getElementById("cartBtn").addEventListener("click", () => {
  if (state.cartRec) {
    finishCartRecording();
    return;
  }
  const local = state.players.find(p => p.isLocal) || state.players[0];
  if (!local || !state.world || state.world === "MainMenu") {
    alert("Нет данных о позиции игрока — зайди в игру.");
    return;
  }
  state.cartRec = { samples: [] };
  const btn = document.getElementById("cartBtn");
  btn.classList.add("recording");
  btn.textContent = "Стоп (0 м)";
});

// ==================== Заметки (общий блокнот, синхронизация ПК/телефон) ====================

const notesText = document.getElementById("notesText");
const notesStatus = document.getElementById("notesStatus");
let notesServerText = null;   // последний известный текст на сервере
let notesSaveTimer = null;

async function loadNotes() {
  try {
    const data = await (await fetch("/api/notes")).json();
    notesServerText = data.text;
    notesText.value = data.text;
    notesStatus.textContent = "синхронизировано";
  } catch (err) {
    notesStatus.textContent = "сервер недоступен";
  }
}

async function saveNotes() {
  const text = notesText.value;
  notesStatus.textContent = "сохранение…";
  try {
    const resp = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (resp.ok) {
      notesServerText = text;
      notesStatus.textContent = "сохранено";
    } else {
      notesStatus.textContent = "ошибка сохранения";
    }
  } catch (err) {
    notesStatus.textContent = "сервер недоступен — правки не сохранены";
  }
}

notesText.addEventListener("input", () => {
  notesStatus.textContent = "печатаешь…";
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(saveNotes, 800);
});

// Подтягиваем чужие правки (например, с телефона), не мешая набору текста
async function pollNotes() {
  try {
    const popupOpen = !document.getElementById("notesPopup").classList.contains("hidden");
    if (popupOpen && notesServerText !== null) {
      const data = await (await fetch("/api/notes")).json();
      const localDirty = notesText.value !== notesServerText;
      if (data.text !== notesServerText && !localDirty && document.activeElement !== notesText) {
        notesServerText = data.text;
        notesText.value = data.text;
        notesStatus.textContent = "обновлено с другого устройства";
      }
    }
  } catch (err) { /* попробуем в следующий раз */ }
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
  } catch (err) { /* сервер недоступен */ }
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

// ==================== Старт ====================

loadWorlds();
connectStream();
pollScan();
pollWalked();
initImagesPopup();
