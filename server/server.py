"""AF LiveMap server.

Локальный сервер без зависимостей (stdlib): отдаёт веб-карту, данные позиций
из livemap.json (который пишет UE4SS-мод) и стрим обновлений через SSE.

Запуск:
    python server.py --data "C:\\...\\ue4ss\\Mods\\AFLiveMap\\livemap.json" [--port 8765]
"""

import argparse
import io
import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if isinstance(sys.stdout, io.TextIOWrapper) and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "..", "web")
MAPS_DIR = os.path.join(ROOT, "..", "maps")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


class DataWatcher:
    """Следит за livemap.json и держит последнее валидное состояние."""

    def __init__(self, data_path: str):
        self.data_path = data_path
        self.state = None
        self.version = 0
        self._lock = threading.Lock()
        self._last_mtime = 0.0
        thread = threading.Thread(target=self._watch, daemon=True)
        thread.start()

    def _watch(self):
        while True:
            try:
                mtime = os.path.getmtime(self.data_path)
                if mtime != self._last_mtime:
                    with open(self.data_path, "r", encoding="utf-8") as f:
                        raw = f.read()
                    state = json.loads(raw)
                    with self._lock:
                        self.state = state
                        self.version += 1
                    self._last_mtime = mtime
                    if walked_store is not None:
                        walked_store.ingest(state)
            except (OSError, json.JSONDecodeError):
                # Файл ещё не создан или пишется прямо сейчас — пробуем позже
                pass
            time.sleep(0.05)

    def snapshot(self):
        with self._lock:
            return self.state, self.version


class ScanStore:
    """Копит лидар-точки в воксельную сетку (50 см) и сохраняет на диск.

    Ключ вокселя — (gx, gy, gz) в ячейках по 50 см. Старые сохранения с другим
    размером ячейки переквантуются при загрузке.
    """

    CELL = 50.0
    MAX_COUNT = 10   # потолок счётчика: старый мусор не становится «непробиваемым»
    CARVE = 5        # на сколько уменьшает счётчик луч, прошедший сквозь воксель

    def __init__(self, lidar_path: str, persist_path: str):
        self.lidar_path = lidar_path
        self.persist_path = persist_path
        # world -> {(gx, gy, gz): [count, version]}
        self.worlds: dict = {}
        self.version = 0
        self.epoch = 1  # растёт при удалении ячеек: клиенты сбрасывают кэш
        self.elevators: list = []  # зоны лифтов: скан внутри не копится
        self._lock = threading.Lock()
        self._last_seq = None
        self._last_mtime = 0.0
        self._dirty = False
        self._load()
        thread = threading.Thread(target=self._watch, daemon=True)
        thread.start()

    @staticmethod
    def _in_zone(elevator: dict, world: str, x: float, y: float, z: float) -> bool:
        if elevator.get("world") != world:
            return False
        dx = x - elevator["x"]
        dy = y - elevator["y"]
        if dx * dx + dy * dy > elevator["radius"] ** 2:
            return False
        stops = elevator["stops"]
        return (min(stops) - 200) <= z <= (max(stops) + 350)

    def set_elevators(self, elevators: list):
        with self._lock:
            self.elevators = elevators

    def purge_zone(self, elevator: dict):
        """Удалить уже накопленные ячейки внутри зоны лифта."""
        world = elevator.get("world") or "unknown"
        with self._lock:
            cells = self.worlds.get(world)
            if not cells:
                return 0
            doomed = [
                key for key in cells
                if self._in_zone(elevator, world,
                                 (key[0] + 0.5) * self.CELL,
                                 (key[1] + 0.5) * self.CELL,
                                 (key[2] + 0.5) * self.CELL)
            ]
            for key in doomed:
                del cells[key]
            if doomed:
                self.epoch += 1
                self.version += 1
                self._dirty = True
            return len(doomed)

    def _load(self):
        try:
            with open(self.persist_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict) and "worlds" in raw:
                stored_cell = float(raw.get("cell", self.CELL))
                worlds_raw = raw["worlds"]
            else:
                stored_cell = 25.0  # старый формат без метаданных
                worlds_raw = raw
            ratio = stored_cell / self.CELL
            for world, cells in worlds_raw.items():
                target = self.worlds.setdefault(world, {})
                for c in cells:
                    key = (
                        math.floor(c[0] * ratio),
                        math.floor(c[1] * ratio),
                        math.floor(c[2] * ratio),
                    )
                    cell = target.get(key)
                    if cell:
                        cell[0] = min(cell[0] + c[3], self.MAX_COUNT)
                    else:
                        target[key] = [min(c[3], self.MAX_COUNT), 1]
            self.version = 1
            if ratio != 1.0:
                self._dirty = True  # пересохранить в новом размере ячейки
            total = sum(len(c) for c in self.worlds.values())
            print(f"Скан загружен: {total} ячеек, миров: {len(self.worlds)}"
                  + (f" (переквантовано {stored_cell:g} см → {self.CELL:g} см)" if ratio != 1.0 else ""))
        except (OSError, json.JSONDecodeError, KeyError, IndexError, TypeError, ValueError):
            pass

    def _save(self):
        with self._lock:
            if not self._dirty:
                return
            raw = {
                "cell": self.CELL,
                "worlds": {
                    # надгробия (count 0) на диск не пишем — они нужны только
                    # живым клиентам для инкрементального удаления
                    world: [[k[0], k[1], k[2], v[0]] for k, v in cells.items() if v[0] > 0]
                    for world, cells in self.worlds.items()
                },
            }
            self._dirty = False
        tmp = self.persist_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(raw, f)
        os.replace(tmp, self.persist_path)

    def _carve_ray(self, cells, origin, point):
        """Луч прошёл от origin до point: воксели по пути — пустота.

        Уменьшаем их счётчик; на нуле воксель становится «надгробием» [0, version],
        чтобы клиенты узнали об удалении инкрементально. Так стирается мусор от
        машин/NPC: достаточно посмотреть сквозь место, где они были.
        """
        dx = point[0] - origin[0]
        dy = point[1] - origin[1]
        dz = point[2] - origin[2]
        distance = math.sqrt(dx * dx + dy * dy + dz * dz)
        # Не трогаем метр у камеры и полклетки у поверхности попадания
        start, stop = 100.0, distance - self.CELL
        if stop <= start:
            return
        step = self.CELL / 2
        seen = set()
        t = start
        while t < stop:
            k = (int((origin[0] + dx * t / distance) // self.CELL),
                 int((origin[1] + dy * t / distance) // self.CELL),
                 int((origin[2] + dz * t / distance) // self.CELL))
            if k not in seen:
                seen.add(k)
                cell = cells.get(k)
                if cell and cell[0] > 0:
                    cell[0] = max(0, cell[0] - self.CARVE)
                    cell[1] = self.version
                    self._dirty = True
            t += step

    def _ingest(self, batch: dict):
        seq = batch.get("seq")
        world = batch.get("world") or "unknown"
        points = batch.get("points") or []
        origin = batch.get("origin")
        if seq is not None and seq == self._last_seq:
            return
        self._last_seq = seq
        with self._lock:
            cells = self.worlds.setdefault(world, {})
            self.version += 1
            for point in points:
                if origin:
                    self._carve_ray(cells, origin, point)
                if any(self._in_zone(e, world, point[0], point[1], point[2]) for e in self.elevators):
                    continue  # внутри зоны лифта не сканируем (движущаяся кабина = мусор)
                gx = int(point[0] // self.CELL)
                gy = int(point[1] // self.CELL)
                gz = int(point[2] // self.CELL)
                key = (gx, gy, gz)
                cell = cells.get(key)
                if cell:
                    cell[0] = min(cell[0] + 1, self.MAX_COUNT)
                    cell[1] = self.version
                else:
                    cells[key] = [1, self.version]
            self._dirty = True

    def _watch(self):
        last_save = time.time()
        while True:
            try:
                mtime = os.path.getmtime(self.lidar_path)
                if mtime != self._last_mtime:
                    with open(self.lidar_path, "r", encoding="utf-8") as f:
                        batch = json.load(f)
                    self._ingest(batch)
                    self._last_mtime = mtime
            except (OSError, json.JSONDecodeError):
                pass
            if time.time() - last_save > 30:
                try:
                    self._save()
                except OSError:
                    pass
                last_save = time.time()
            time.sleep(0.05)

    def query(self, world: str, since: int):
        with self._lock:
            cells = self.worlds.get(world, {})
            changed = [
                [k[0], k[1], k[2], v[0]]
                for k, v in cells.items()
                if v[1] > since
            ]
            return {"version": self.version, "epoch": self.epoch, "world": world, "cells": changed}


class WalkedStore:
    """Клетки, где игрок физически прошёл: истина о проходимости.

    Маршрутизатор считает их проходимыми поверх скана — так двери,
    которые в скане выглядят стеной, не рвут маршруты: достаточно
    один раз пройти через дверь.
    """

    CELL = 50.0
    FEET_OFFSET = 90.0  # z пешки — центр капсулы, ноги ниже на ~90 см

    def __init__(self, persist_path: str):
        self.persist_path = persist_path
        # world -> {(gx, gy, gz): version}
        self.worlds: dict = {}
        self.version = 0
        self._lock = threading.Lock()
        self._dirty = False
        self._load()
        thread = threading.Thread(target=self._saver, daemon=True)
        thread.start()

    def _load(self):
        try:
            with open(self.persist_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            for world, cells in raw.get("worlds", {}).items():
                self.worlds[world] = {(c[0], c[1], c[2]): 1 for c in cells}
            self.version = 1
            total = sum(len(c) for c in self.worlds.values())
            print(f"Прохоженные клетки загружены: {total}")
        except (OSError, json.JSONDecodeError, KeyError, IndexError, TypeError):
            pass

    def _saver(self):
        while True:
            time.sleep(30)
            with self._lock:
                if not self._dirty:
                    continue
                raw = {
                    "worlds": {
                        world: [[k[0], k[1], k[2]] for k in cells]
                        for world, cells in self.worlds.items()
                    }
                }
                self._dirty = False
            try:
                tmp = self.persist_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(raw, f)
                os.replace(tmp, self.persist_path)
            except OSError:
                pass

    def ingest(self, state: dict):
        world = state.get("world")
        if not world or world in ("unknown", "MainMenu"):
            return
        players = state.get("players") or []
        elevators = scan_store.elevators if scan_store else []
        with self._lock:
            cells = self.worlds.setdefault(world, {})
            bumped = False
            for player in players:
                try:
                    x, y = float(player["x"]), float(player["y"])
                    z = float(player["z"]) - self.FEET_OFFSET
                except (KeyError, TypeError, ValueError):
                    continue
                # В шахте лифта не отмечаем: вертикальная «лесенка» ломала бы граф
                if any(ScanStore._in_zone(e, world, x, y, z) for e in elevators):
                    continue
                key = (int(x // self.CELL), int(y // self.CELL), int(z // self.CELL))
                if key not in cells:
                    if not bumped:
                        self.version += 1
                        bumped = True
                    cells[key] = self.version
                    self._dirty = True

    def query(self, world: str, since: int):
        with self._lock:
            cells = self.worlds.get(world, {})
            changed = [[k[0], k[1], k[2]] for k, v in cells.items() if v > since]
            return {"version": self.version, "world": world, "cells": changed}


watcher: "DataWatcher | None" = None
scan_store: "ScanStore | None" = None
walked_store: "WalkedStore | None" = None


def rename_in(items: list, target_id, new_name: str) -> bool:
    for item in items:
        if item.get("id") == target_id:
            item["name"] = new_name[:64]
            return True
    return False

waypoints_path: str = ""
waypoints_lock = threading.Lock()

elevators_path: str = ""
elevators_lock = threading.Lock()


def load_waypoints() -> list:
    try:
        with open(waypoints_path, "r", encoding="utf-8") as f:
            return json.load(f).get("waypoints", [])
    except (OSError, json.JSONDecodeError):
        return []


def save_waypoints(waypoints: list):
    tmp = waypoints_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"waypoints": waypoints}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, waypoints_path)


portals_path: str = ""
portals_lock = threading.Lock()


def load_portals_data() -> dict:
    try:
        with open(portals_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return {"portals": raw.get("portals", []), "ignore": raw.get("ignore", [])}
    except (OSError, json.JSONDecodeError):
        return {"portals": [], "ignore": []}


def save_portals_data(data: dict):
    tmp = portals_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, portals_path)


def in_ignore_zone(zones: list, world: str, x: float, y: float, z: float) -> bool:
    for zone in zones:
        if zone.get("world") != world:
            continue
        if math.hypot(x - zone["x"], y - zone["y"], z - zone["z"]) < zone["radius"]:
            return True
    return False


carts_path: str = ""
carts_lock = threading.Lock()

notes_path: str = ""
notes_lock = threading.Lock()


def load_notes() -> dict:
    try:
        with open(notes_path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return {"text": raw.get("text", ""), "updated": raw.get("updated", 0)}
    except (OSError, json.JSONDecodeError):
        return {"text": "", "updated": 0}


def save_notes(text: str) -> dict:
    data = {"text": text, "updated": int(time.time() * 1000)}
    tmp = notes_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, notes_path)
    return data


def load_carts() -> list:
    try:
        with open(carts_path, "r", encoding="utf-8") as f:
            return json.load(f).get("carts", [])
    except (OSError, json.JSONDecodeError):
        return []


def save_carts(carts: list):
    tmp = carts_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"carts": carts}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, carts_path)


def load_elevators() -> list:
    try:
        with open(elevators_path, "r", encoding="utf-8") as f:
            return json.load(f).get("elevators", [])
    except (OSError, json.JSONDecodeError):
        return []


def save_elevators(elevators: list):
    tmp = elevators_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"elevators": elevators}, f, ensure_ascii=False, indent=2)
    os.replace(tmp, elevators_path)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        del format, args

    def _send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, base_dir: str, rel_path: str):
        safe_path = os.path.normpath(rel_path).lstrip("\\/")
        full_path = os.path.join(base_dir, safe_path)
        if not os.path.abspath(full_path).startswith(os.path.abspath(base_dir)):
            self._send_json({"error": "forbidden"}, 403)
            return
        if not os.path.isfile(full_path):
            self._send_json({"error": "not found"}, 404)
            return
        ext = os.path.splitext(full_path)[1].lower()
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self._send_file(WEB_DIR, "index.html")
        elif path == "/api/state":
            assert watcher is not None
            state, version = watcher.snapshot()
            self._send_json({"version": version, "state": state})
        elif path == "/api/stream":
            self._stream_sse()
        elif path == "/api/scan":
            assert scan_store is not None
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or ["unknown"])[0]
            try:
                since = int((query.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            self._send_json(scan_store.query(world, since))
        elif path == "/api/worlds":
            assert scan_store is not None
            with waypoints_lock:
                waypoint_worlds = {w.get("world") for w in load_waypoints()}
            with scan_store._lock:
                scan_worlds = set(scan_store.worlds.keys())
            worlds = sorted((scan_worlds | waypoint_worlds) - {None, "", "unknown", "MainMenu"})
            self._send_json({"worlds": worlds})
        elif path == "/api/waypoints":
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or [None])[0]
            with waypoints_lock:
                waypoints = load_waypoints()
            if world:
                waypoints = [w for w in waypoints if w.get("world") == world]
            self._send_json({"waypoints": waypoints})
        elif path == "/api/elevators":
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or [None])[0]
            with elevators_lock:
                elevators = load_elevators()
            if world:
                elevators = [e for e in elevators if e.get("world") == world]
            self._send_json({"elevators": elevators})
        elif path == "/api/portals":
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or [None])[0]
            with portals_lock:
                data = load_portals_data()
            portals = data["portals"]
            ignore = data["ignore"]
            if world:
                portals = [
                    p for p in portals
                    if p["from"].get("world") == world or p["to"].get("world") == world
                ]
                ignore = [z for z in ignore if z.get("world") == world]
            self._send_json({"portals": portals, "ignore": ignore})
        elif path == "/api/carts":
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or [None])[0]
            with carts_lock:
                carts = load_carts()
            if world:
                carts = [c for c in carts if c.get("world") == world]
            self._send_json({"carts": carts})
        elif path == "/api/walked":
            assert walked_store is not None
            from urllib.parse import parse_qs, urlparse
            query = parse_qs(urlparse(self.path).query)
            world = (query.get("world") or ["unknown"])[0]
            try:
                since = int((query.get("since") or ["0"])[0])
            except ValueError:
                since = 0
            self._send_json(walked_store.query(world, since))
        elif path == "/api/notes":
            with notes_lock:
                self._send_json(load_notes())
        elif path == "/api/maps":
            self._send_file(MAPS_DIR, "maps.json")
        elif path.startswith("/maps/"):
            self._send_file(MAPS_DIR, path[len("/maps/"):])
        else:
            self._send_file(WEB_DIR, path)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/notes":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            with notes_lock:
                self._send_json(save_notes(str(payload.get("text", ""))[:200000]))
        elif path == "/api/waypoints":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            action = payload.get("action")
            with waypoints_lock:
                waypoints = load_waypoints()
                if action == "add":
                    waypoint = {
                        "id": str(int(time.time() * 1000)),
                        "name": str(payload.get("name") or "Точка")[:64],
                        "world": payload.get("world") or "unknown",
                        "x": float(payload.get("x", 0)),
                        "y": float(payload.get("y", 0)),
                        "z": float(payload.get("z", 0)),
                    }
                    waypoints.append(waypoint)
                    save_waypoints(waypoints)
                    self._send_json({"ok": True, "waypoint": waypoint})
                elif action == "delete":
                    target_id = payload.get("id")
                    waypoints = [w for w in waypoints if w.get("id") != target_id]
                    save_waypoints(waypoints)
                    self._send_json({"ok": True})
                elif action == "rename":
                    if rename_in(waypoints, payload.get("id"), str(payload.get("name") or "Точка")):
                        save_waypoints(waypoints)
                    self._send_json({"ok": True})
                else:
                    self._send_json({"error": "unknown action"}, 400)
        elif path == "/api/elevators":
            assert scan_store is not None
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            action = payload.get("action")
            with elevators_lock:
                elevators = load_elevators()
                if action == "add":
                    stops = sorted(float(z) for z in payload.get("stops") or [])
                    if len(stops) < 2:
                        self._send_json({"error": "нужно минимум 2 остановки"}, 400)
                        return
                    elevator = {
                        "id": str(int(time.time() * 1000)),
                        "name": str(payload.get("name") or "Лифт")[:64],
                        "world": payload.get("world") or "unknown",
                        "x": float(payload.get("x", 0)),
                        "y": float(payload.get("y", 0)),
                        "radius": max(150.0, min(800.0, float(payload.get("radius", 250)))),
                        "doors": bool(payload.get("doors")),
                        "stops": stops,
                    }
                    elevators.append(elevator)
                    save_elevators(elevators)
                    scan_store.set_elevators(elevators)
                    purged = scan_store.purge_zone(elevator)
                    self._send_json({"ok": True, "elevator": elevator, "purgedCells": purged})
                elif action == "delete":
                    target_id = payload.get("id")
                    elevators = [e for e in elevators if e.get("id") != target_id]
                    save_elevators(elevators)
                    scan_store.set_elevators(elevators)
                    self._send_json({"ok": True})
                elif action == "rename":
                    if rename_in(elevators, payload.get("id"), str(payload.get("name") or "Лифт")):
                        save_elevators(elevators)
                        scan_store.set_elevators(elevators)
                    self._send_json({"ok": True})
                else:
                    self._send_json({"error": "unknown action"}, 400)
        elif path == "/api/portals":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            action = payload.get("action")
            with portals_lock:
                data = load_portals_data()
                portals = data["portals"]
                if action == "add":
                    src = payload.get("from") or {}
                    dst = payload.get("to") or {}
                    # Телепорт в зону «не портал» (база и т.п.) — не записываем
                    if in_ignore_zone(data["ignore"], dst.get("world") or "unknown",
                                      float(dst.get("x", 0)), float(dst.get("y", 0)), float(dst.get("z", 0))):
                        self._send_json({"ok": True, "ignored": True, "duplicate": True})
                        return
                    # Дедуп: тот же портал = совпадают миры и обе точки в радиусе 5 м
                    def near(a, b):
                        return (a.get("world") == b.get("world")
                                and math.hypot(a.get("x", 0) - b.get("x", 0),
                                               a.get("y", 0) - b.get("y", 0),
                                               a.get("z", 0) - b.get("z", 0)) < 500)
                    existing = next(
                        (p for p in portals if near(p["from"], src) and near(p["to"], dst)),
                        None)
                    if existing:
                        existing["count"] = existing.get("count", 1) + 1
                        save_portals_data(data)
                        self._send_json({"ok": True, "portal": existing, "duplicate": True})
                    else:
                        portal = {
                            "id": str(int(time.time() * 1000)),
                            "name": str(payload.get("name") or "Портал")[:64],
                            "count": 1,
                            "from": {"world": src.get("world") or "unknown",
                                     "x": float(src.get("x", 0)), "y": float(src.get("y", 0)),
                                     "z": float(src.get("z", 0))},
                            "to": {"world": dst.get("world") or "unknown",
                                   "x": float(dst.get("x", 0)), "y": float(dst.get("y", 0)),
                                   "z": float(dst.get("z", 0))},
                        }
                        portals.append(portal)
                        save_portals_data(data)
                        self._send_json({"ok": True, "portal": portal, "duplicate": False})
                elif action == "delete":
                    data["portals"] = [p for p in portals if p.get("id") != payload.get("id")]
                    save_portals_data(data)
                    self._send_json({"ok": True})
                elif action == "rename":
                    if (rename_in(portals, payload.get("id"), str(payload.get("name") or "Портал"))
                            or rename_in(data["ignore"], payload.get("id"), str(payload.get("name") or "Зона"))):
                        save_portals_data(data)
                    self._send_json({"ok": True})
                elif action == "add_ignore":
                    zone = {
                        "id": str(int(time.time() * 1000)),
                        "name": str(payload.get("name") or "База")[:64],
                        "world": payload.get("world") or "unknown",
                        "x": float(payload.get("x", 0)),
                        "y": float(payload.get("y", 0)),
                        "z": float(payload.get("z", 0)),
                        "radius": max(300.0, min(10000.0, float(payload.get("radius", 1500)))),
                    }
                    data["ignore"].append(zone)
                    # Существующие мусорные порталы с выходом в зоне — удаляем сразу
                    before = len(data["portals"])
                    data["portals"] = [
                        p for p in data["portals"]
                        if not in_ignore_zone([zone], p["to"].get("world") or "unknown",
                                              p["to"].get("x", 0), p["to"].get("y", 0), p["to"].get("z", 0))
                    ]
                    save_portals_data(data)
                    self._send_json({"ok": True, "zone": zone, "purgedPortals": before - len(data["portals"])})
                elif action == "delete_ignore":
                    data["ignore"] = [z for z in data["ignore"] if z.get("id") != payload.get("id")]
                    save_portals_data(data)
                    self._send_json({"ok": True})
                else:
                    self._send_json({"error": "unknown action"}, 400)
        elif path == "/api/carts":
            length = int(self.headers.get("Content-Length", 0))
            try:
                payload = json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            action = payload.get("action")
            with carts_lock:
                carts = load_carts()
                if action == "add":
                    path_points = payload.get("path") or []
                    if len(path_points) < 2:
                        self._send_json({"error": "слишком короткий путь"}, 400)
                        return
                    cart = {
                        "id": str(int(time.time() * 1000)),
                        "name": str(payload.get("name") or "Тележка")[:64],
                        "world": payload.get("world") or "unknown",
                        "path": [[float(p[0]), float(p[1]), float(p[2])] for p in path_points],
                    }
                    carts.append(cart)
                    save_carts(carts)
                    self._send_json({"ok": True, "cart": cart})
                elif action == "delete":
                    target_id = payload.get("id")
                    carts = [c for c in carts if c.get("id") != target_id]
                    save_carts(carts)
                    self._send_json({"ok": True})
                elif action == "rename":
                    if rename_in(carts, payload.get("id"), str(payload.get("name") or "Тележка")):
                        save_carts(carts)
                    self._send_json({"ok": True})
                else:
                    self._send_json({"error": "unknown action"}, 400)
        elif path == "/api/maps":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self._send_json({"error": "invalid json"}, 400)
                return
            maps_file = os.path.join(MAPS_DIR, "maps.json")
            with open(maps_file, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            self._send_json({"ok": True})
        else:
            self._send_json({"error": "not found"}, 404)

    def _stream_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        w = watcher
        assert w is not None
        last_version = -1
        last_heartbeat = time.time()
        try:
            while True:
                state, version = w.snapshot()
                if version != last_version and state is not None:
                    payload = json.dumps({"version": version, "state": state}, ensure_ascii=False)
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_version = version
                    last_heartbeat = time.time()
                elif time.time() - last_heartbeat > 15:
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    last_heartbeat = time.time()
                time.sleep(0.05)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


class QuietHTTPServer(ThreadingHTTPServer):
    """Не спамит трейсбеками, когда браузер обрывает keep-alive соединение."""

    def handle_error(self, request, client_address):
        exc = sys.exception()
        if isinstance(exc, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    parser = argparse.ArgumentParser(description="AF LiveMap server")
    parser.add_argument("--data", required=True, help="Путь к livemap.json, который пишет UE4SS-мод")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="0.0.0.0",
                        help="0.0.0.0 — доступ из локальной сети (телефон), 127.0.0.1 — только этот ПК")
    args = parser.parse_args()

    if not os.path.isfile(args.data):
        print("!" * 60)
        print(f"ВНИМАНИЕ: файл не найден: {args.data}")
        print("Позиции и скан НЕ будут обновляться, пока файл не появится.")
        print("Проверь путь к игре (папка ue4ss\\Mods\\AFLiveMap).")
        print("!" * 60)

    global watcher, scan_store, walked_store
    watcher = DataWatcher(args.data)

    lidar_path = os.path.join(os.path.dirname(os.path.abspath(args.data)), "lidar.json")
    persist_dir = os.path.join(ROOT, "..", "data")
    os.makedirs(persist_dir, exist_ok=True)
    scan_store = ScanStore(lidar_path, os.path.join(persist_dir, "scan.json"))

    global waypoints_path, elevators_path, portals_path, carts_path, notes_path
    waypoints_path = os.path.join(persist_dir, "waypoints.json")
    elevators_path = os.path.join(persist_dir, "elevators.json")
    portals_path = os.path.join(persist_dir, "portals.json")
    carts_path = os.path.join(persist_dir, "carts.json")
    notes_path = os.path.join(persist_dir, "notes.json")
    scan_store.set_elevators(load_elevators())
    walked_store = WalkedStore(os.path.join(persist_dir, "walked.json"))

    server = QuietHTTPServer((args.host, args.port), Handler)
    print(f"AF LiveMap (этот ПК): http://127.0.0.1:{args.port}")
    if args.host == "0.0.0.0":
        import socket
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(("8.8.8.8", 80))
            lan_ip = probe.getsockname()[0]
            probe.close()
            print(f"AF LiveMap (телефон в той же сети): http://{lan_ip}:{args.port}")
            print("Если телефон не открывает: разреши python в брандмауэре Windows (диалог при первом запуске).")
        except OSError:
            pass
    print(f"Данные: {args.data}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
