@echo off
setlocal enabledelayedexpansion
title AF LiveMap Server
cd /d "%~dp0"

echo ============================================
echo   AF LiveMap - server launcher
echo ============================================
echo.

REM --- 1. Find Python -----------------------------------------------------
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )
if not defined PY (
  echo [X] Python was not found.
  echo     Install it from https://www.python.org/downloads/
  echo     and TICK "Add Python to PATH" during setup, then run this again.
  echo.
  pause
  exit /b 1
)

REM --- 2. Auto-find the game's AFLiveMap mod folder ----------------------
REM    (the mod writes livemap.json here once the game has run with it)
set "DATA="
for %%D in (C D E F G) do (
  for %%P in (
    "%%D:\Program Files (x86)\Steam\steamapps\common\AbioticFactor"
    "%%D:\Program Files\Steam\steamapps\common\AbioticFactor"
    "%%D:\SteamLibrary\steamapps\common\AbioticFactor"
    "%%D:\Steam\steamapps\common\AbioticFactor"
    "%%D:\Games\AbioticFactor"
    "%%D:\AbioticFactor"
  ) do (
    if exist "%%~P\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\Scripts\main.lua" (
      set "DATA=%%~P\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\livemap.json"
    )
  )
)

REM --- 3. Fall back to a saved path, or ask ------------------------------
if not defined DATA if exist "%~dp0livemap-path.txt" (
  set /p DATA=<"%~dp0livemap-path.txt"
)

if not defined DATA (
  echo [!] Could not auto-find your game folder.
  echo     Make sure the AFLiveMap mod is installed in
  echo     ...\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\
  echo.
  echo     Paste the FULL path to your game's livemap.json below, for example:
  echo     C:\Games\AbioticFactor\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\livemap.json
  echo.
  set /p DATA="Path to livemap.json: "
  if defined DATA >"%~dp0livemap-path.txt" echo !DATA!
)

if not defined DATA (
  echo No path given. Exiting.
  pause
  exit /b 1
)

echo.
echo Data file: !DATA!
echo Starting server... open http://127.0.0.1:8765 in your browser.
echo (Press Ctrl+C in this window to stop.)
echo.
%PY% "%~dp0server\server.py" --data "!DATA!"
pause
