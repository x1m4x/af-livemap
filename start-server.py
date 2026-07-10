#!/usr/bin/env python3
"""AF LiveMap — one-click launcher.

Double-click this file (Python must be installed), or run:
    python start-server.py

It finds the game's AFLiveMap mod folder, then starts the server. If it can't
find the game it asks you to paste the path to livemap.json once and remembers it.
"""

import os
import sys
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SAVED = os.path.join(HERE, "livemap-path.txt")

# ...\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap
MOD_SUBPATH = os.path.join(
    "AbioticFactor", "Binaries", "Win64", "ue4ss", "Mods", "AFLiveMap"
)


def find_data():
    """Look for the installed mod in common game locations."""
    for drive in "CDEFG":
        for base in (
            rf"{drive}:\Program Files (x86)\Steam\steamapps\common\AbioticFactor",
            rf"{drive}:\Program Files\Steam\steamapps\common\AbioticFactor",
            rf"{drive}:\SteamLibrary\steamapps\common\AbioticFactor",
            rf"{drive}:\Steam\steamapps\common\AbioticFactor",
            rf"{drive}:\Games\AbioticFactor",
            rf"{drive}:\AbioticFactor",
        ):
            mod = os.path.join(base, MOD_SUBPATH)
            if os.path.isfile(os.path.join(mod, "Scripts", "main.lua")):
                return os.path.join(mod, "livemap.json")
    return None


def main():
    data = find_data()
    if not data and os.path.isfile(SAVED):
        with open(SAVED, encoding="utf-8") as f:
            data = f.read().strip()

    if not data:
        print("Could not auto-find your game folder.")
        print("Make sure the AFLiveMap mod is installed in")
        print(r"  ...\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap")
        print()
        print("Paste the FULL path to your game's livemap.json, for example:")
        print(r"  C:\Games\AbioticFactor\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\livemap.json")
        data = input("Path to livemap.json: ").strip().strip('"')
        if data:
            with open(SAVED, "w", encoding="utf-8") as f:
                f.write(data)

    if not data:
        print("No path given.")
        input("Press Enter to exit.")
        return

    print(f"Data file: {data}")
    print("Starting server... open http://127.0.0.1:8765 in your browser.")
    print("(Press Ctrl+C in this window to stop.)")
    print()
    try:
        subprocess.run([sys.executable, os.path.join(HERE, "server", "server.py"),
                        "--data", data])
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # keep the window open on double-click errors
        print("Error:", exc)
        input("Press Enter to exit.")
