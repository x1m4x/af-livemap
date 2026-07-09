"""Симулятор мода: пишет livemap.json с движущимися игроками.

Позволяет проверить сервер и веб-карту без запущенной игры:
    python tools/fake_player.py --out livemap.json
"""

import argparse
import io
import json
import math
import os
import sys
import time

if isinstance(sys.stdout, io.TextIOWrapper) and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


WALL = 8000.0    # «комната» ±80 м
FLOOR_Z = 0.0    # пол
CEILING_Z = 500.0  # потолок 5 м


def ray_exit_distance(origin, direction):
    """Расстояние до выхода из AABB-комнаты из точки внутри (метод плит)."""
    bounds = [(-WALL, WALL), (-WALL, WALL), (FLOOR_Z, CEILING_Z)]
    best = math.inf
    for axis in range(3):
        d = direction[axis]
        if abs(d) < 1e-9:
            continue
        low, high = bounds[axis]
        boundary = high if d > 0 else low
        t = (boundary - origin[axis]) / d
        if 0 < t < best:
            best = t
    return best


def lidar_points(px, py, pz, phase, rays=48, max_range=6000.0):
    """Сферический веер по золотой спирали — как в моде."""
    golden = math.pi * (3.0 - math.sqrt(5.0))
    origin = (px, py, pz)
    points = []
    for i in range(rays):
        t = (i + 0.5) / rays
        dz = 1.0 - 2.0 * t
        radius = math.sqrt(max(0.0, 1.0 - dz * dz))
        phi = i * golden + phase
        direction = (math.cos(phi) * radius, math.sin(phi) * radius, dz)
        dist = ray_exit_distance(origin, direction)
        if dist <= max_range:
            points.append([
                round(px + direction[0] * dist),
                round(py + direction[1] * dist),
                round(pz + direction[2] * dist),
            ])
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="livemap.json")
    parser.add_argument("--interval", type=float, default=0.2)
    args = parser.parse_args()

    seq = 0
    start = time.time()
    print(f"Пишу фейковые позиции в {args.out} (Ctrl+C для остановки)")
    while True:
        elapsed = time.time() - start
        # Локальный игрок ходит по кругу радиусом 50 м, второй — по восьмёрке
        state = {
            "seq": seq,
            "world": "Facility",
            "players": [
                {
                    "id": "1",
                    "name": "LocalHero",
                    "x": 5000 * math.cos(elapsed * 0.3),
                    "y": 5000 * math.sin(elapsed * 0.3),
                    "z": 100.0,
                    "yaw": math.degrees(elapsed * 0.3) + 90,
                    "isLocal": True,
                },
                {
                    "id": "2",
                    "name": "Coworker",
                    "x": 8000 * math.sin(elapsed * 0.2),
                    "y": 4000 * math.sin(elapsed * 0.4),
                    "z": 100.0,
                    "yaw": math.degrees(elapsed * 0.4),
                    "isLocal": False,
                },
            ],
        }
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(state, f)

        local = state["players"][0]
        lidar = {
            "seq": seq,
            "world": "Facility",
            "points": lidar_points(local["x"], local["y"], local["z"] + 60, phase=(seq * 0.7) % (2 * math.pi)),
        }
        lidar_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), "lidar.json")
        with open(lidar_path, "w", encoding="utf-8") as f:
            json.dump(lidar, f)

        seq += 1
        time.sleep(args.interval)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
