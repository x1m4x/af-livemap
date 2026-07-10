"""Build dist/AF-LiveMap-<version>.zip.

The version is read from VERSION in server/server.py — the single source of
truth — so the archive name can never drift from what the server reports.
Run from the repo root:  python tools/build_dist.py
"""

import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAPPING = [
    ("README.md", "AF-LiveMap/README.md"),
    ("README.ru.md", "AF-LiveMap/README.ru.md"),
    ("CHANGELOG.md", "AF-LiveMap/CHANGELOG.md"),
    ("LICENSE", "AF-LiveMap/LICENSE"),
    ("start-server.py", "AF-LiveMap/start-server.py"),
    ("mod/enabled.txt", "AF-LiveMap/AFLiveMap/enabled.txt"),
    ("mod/config.txt", "AF-LiveMap/AFLiveMap/config.txt"),
    ("mod/Scripts/main.lua", "AF-LiveMap/AFLiveMap/Scripts/main.lua"),
    ("server/server.py", "AF-LiveMap/server/server.py"),
    ("web/index.html", "AF-LiveMap/web/index.html"),
    ("web/style.css", "AF-LiveMap/web/style.css"),
    ("web/app.js", "AF-LiveMap/web/app.js"),
    ("web/view3d.js", "AF-LiveMap/web/view3d.js"),
    ("web/i18n.js", "AF-LiveMap/web/i18n.js"),
    ("web/traders-catalog.json", "AF-LiveMap/web/traders-catalog.json"),
    ("maps/placeholder.svg", "AF-LiveMap/maps/placeholder.svg"),
    ("maps/maps.example.json", "AF-LiveMap/maps/maps.example.json"),
    ("tools/fake_player.py", "AF-LiveMap/tools/fake_player.py"),
]


def main() -> int:
    server_src = open(os.path.join(ROOT, "server", "server.py"), encoding="utf-8").read()
    match = re.search(r'^VERSION = "([^"]+)"', server_src, re.MULTILINE)
    if not match:
        print("VERSION not found in server/server.py")
        return 1
    version = match.group(1)

    missing = [src for src, _ in MAPPING if not os.path.exists(os.path.join(ROOT, src))]
    if missing:
        print("missing files:", missing)
        return 1

    os.makedirs(os.path.join(ROOT, "dist"), exist_ok=True)
    out = os.path.join(ROOT, "dist", f"AF-LiveMap-{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for src, dst in MAPPING:
            z.write(os.path.join(ROOT, src), dst)
    print(f"built {out} ({os.path.getsize(out)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
