-- AFLiveMap: writes player positions and a lidar scan to JSON files for the
-- local live map.
-- Install to: <game>\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\Scripts\main.lua
-- Read by the server: server/server.py --data <path to livemap.json>
--
-- Performance: the game thread only does light data gathering (a few traces
-- and reading positions); JSON encoding and file writes happen on the
-- background LoopAsync thread so game frames are never blocked by disk I/O.

local UEHelpers = require("UEHelpers")

-- ==================== Default settings ====================
-- Values below are defaults. Override them without touching code via the
-- config.txt file next to this mod (see the "Config" section below).

-- Tick interval, ms. Frequent but tiny work — instead of rare heavy spikes.
local INTERVAL_MS = 100

-- Output files. Relative path is resolved from <game>\...\Binaries\Win64\
local MOD_DIR = "ue4ss\\Mods\\AFLiveMap\\"
local OUTPUT_FILE = MOD_DIR .. "livemap.json"
local SCAN_FILE = MOD_DIR .. "lidar.json"
local CONFIG_FILE = MOD_DIR .. "config.txt"

-- Player pawn blueprint class in Abiotic Factor
local PLAYER_CLASS = "Abiotic_PlayerCharacter_C"

-- Lidar: rays per tick. 12 x 10 ticks/s = 120 rays/s spread across frames.
local SCAN_ENABLED = true
local SCAN_RAYS = 12
local SCAN_RANGE = 6000.0       -- ray range, cm (60 m)
local SCAN_MIN_DISTANCE = 60.0  -- closer than this = own body/held item, noise

-- Gate scanning behind the Rat Scanner item.
-- require_rat_scanner = true  -> map is built ONLY while holding the Rat Scanner.
-- require_rat_scanner = false -> scanning always works, no item required.
local REQUIRE_RAT_SCANNER = true
-- Substring of the held item's class name to identify the scanner (case-insensitive).
local SCANNER_ITEM_MATCH = "ratscanner"
-- Diagnostics: print the held item's name to the console (to discover the exact
-- name for scanner_item_match if detection fails). Toggled in config.txt.
local LOG_HELD_ITEM = false

-- UI/log language: "auto" (from game), "en", or "ru".
local LANGUAGE = "auto"

-- Pawn cache refresh (FindAllOf is costly, not called every tick), in ticks
local CACHE_REFRESH_TICKS = 30  -- about every 3 seconds

-- ==========================================================

-- ==================== Localization ====================

local STRINGS = {
    en = {
        config_not_found = "config.txt not found - using default settings",
        config_loaded    = "config.txt loaded: require_rat_scanner=%s, match='%s', language=%s",
        mod_loaded       = "Mod loaded: tick %d ms, lidar %d rays/tick, %s",
        scan_gated       = "scanning only while holding the Rat Scanner",
        scan_always      = "scanning always on",
        lidar_error      = "Lidar not working: %s",
        held_item        = "Item in hand: %s",
        collect_error    = "Collection error: %s",
    },
    ru = {
        config_not_found = "config.txt не найден - работают настройки по умолчанию",
        config_loaded    = "config.txt загружен: require_rat_scanner=%s, match='%s', language=%s",
        mod_loaded       = "Мод загружен: тик %d мс, лидар %d лучей/тик, %s",
        scan_gated       = "скан только с Rat Scanner в руке",
        scan_always      = "скан всегда включён",
        lidar_error      = "Лидар не работает: %s",
        held_item        = "Предмет в руке: %s",
        collect_error    = "Ошибка сбора: %s",
    },
}

local activeLang = "en"

local function T(id, ...)
    local template = (STRINGS[activeLang] and STRINGS[activeLang][id]) or STRINGS.en[id] or id
    if select("#", ...) > 0 then
        return string.format(template, ...)
    end
    return template
end

local function Log(message)
    print(string.format("[AFLiveMap] %s\n", message))
end

-- Detect the game's current language via the engine's internationalization
-- library. Returns a culture string like "en", "ru-RU", or nil on failure.
local function DetectGameLanguage()
    local detected = nil
    pcall(function()
        local lib = StaticFindObject("/Script/Engine.Default__KismetInternationalizationLibrary")
        if lib and lib:IsValid() then
            local culture = lib:GetCurrentLanguage()
            if culture then detected = tostring(culture) end
        end
    end)
    return detected
end

local function ResolveLanguage()
    local choice = (LANGUAGE or "auto"):lower()
    if choice == "en" or choice == "ru" then
        activeLang = choice
        return
    end
    -- "auto" (or anything unknown): follow the game language, default to English
    local game = DetectGameLanguage()
    activeLang = (game and game:lower():find("ru", 1, true)) and "ru" or "en"
end

-- ==================== Config ====================
-- Plain key=value config.txt next to the mod. A missing file is not an error:
-- the defaults above apply. Players edit only config.txt.

local function ParseBool(value, fallback)
    value = value:lower()
    if value == "true" or value == "1" or value == "yes" or value == "on" then return true end
    if value == "false" or value == "0" or value == "no" or value == "off" then return false end
    return fallback
end

local function LoadConfig()
    local file = io.open(CONFIG_FILE, "r")
    if not file then
        ResolveLanguage()
        Log(T("config_not_found"))
        return
    end
    for line in file:lines() do
        local key, value = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
        if key and value and not line:match("^%s*#") then
            key = key:lower()
            if key == "require_rat_scanner" then
                REQUIRE_RAT_SCANNER = ParseBool(value, REQUIRE_RAT_SCANNER)
            elseif key == "scanner_item_match" then
                if #value > 0 then SCANNER_ITEM_MATCH = value:lower() end
            elseif key == "scan_enabled" then
                SCAN_ENABLED = ParseBool(value, SCAN_ENABLED)
            elseif key == "scan_rays" then
                SCAN_RAYS = tonumber(value) or SCAN_RAYS
            elseif key == "scan_range_cm" then
                SCAN_RANGE = tonumber(value) or SCAN_RANGE
            elseif key == "log_held_item" then
                LOG_HELD_ITEM = ParseBool(value, LOG_HELD_ITEM)
            elseif key == "language" then
                if #value > 0 then LANGUAGE = value:lower() end
            end
        end
    end
    file:close()
    ResolveLanguage()
    Log(T("config_loaded", tostring(REQUIRE_RAT_SCANNER), SCANNER_ITEM_MATCH, activeLang))
end

LoadConfig()

-- Minimal JSON encoder: numbers, strings, bool, arrays and objects are enough
local function JsonEncode(value)
    local t = type(value)
    if t == "number" then
        if value ~= value or value == math.huge or value == -math.huge then
            return "0"
        end
        return string.format("%.4f", value)
    elseif t == "string" then
        return '"' .. value:gsub('[%c"\\]', function(c)
            if c == '"' then return '\\"' end
            if c == "\\" then return "\\\\" end
            return string.format("\\u%04x", string.byte(c))
        end) .. '"'
    elseif t == "boolean" then
        return tostring(value)
    elseif t == "table" then
        if value[1] ~= nil or next(value) == nil then
            local parts = {}
            for _, item in ipairs(value) do
                parts[#parts + 1] = JsonEncode(item)
            end
            return "[" .. table.concat(parts, ",") .. "]"
        else
            local parts = {}
            for key, item in pairs(value) do
                parts[#parts + 1] = JsonEncode(tostring(key)) .. ":" .. JsonEncode(item)
            end
            return "{" .. table.concat(parts, ",") .. "}"
        end
    end
    return "null"
end

-- ==================== Pawn cache ====================
-- FindAllOf, player names and the world name change rarely;
-- only positions are read every tick.

local pawnCache = {}   -- array of {pawn, name, isLocal}
local worldName = "unknown"
local ticksSinceRefresh = 1000 -- refresh on the very first tick

local function GetPlayerName(pawn, fallback)
    local name = fallback
    pcall(function()
        local state = pawn.PlayerState
        if state and state:IsValid() then
            local playerName = state:GetPlayerName():ToString()
            if playerName and #playerName > 0 then
                name = playerName
            end
        end
    end)
    return name
end

local function RefreshPawnCache()
    local localPawn = UEHelpers.GetPlayer()
    local localFullName = nil
    if localPawn and localPawn:IsValid() then
        pcall(function() localFullName = localPawn:GetFullName() end)
    end

    local pawns = FindAllOf(PLAYER_CLASS)
    if (not pawns or #pawns == 0) and localPawn and localPawn:IsValid() then
        pawns = { localPawn }
    end

    pawnCache = {}
    if not pawns then return end

    for index, pawn in ipairs(pawns) do
        if pawn:IsValid() then
            local fullName = nil
            pcall(function() fullName = pawn:GetFullName() end)
            pawnCache[#pawnCache + 1] = {
                pawn = pawn,
                name = GetPlayerName(pawn, "Player " .. index),
                isLocal = (fullName ~= nil and fullName == localFullName),
            }
            pcall(function()
                local full = pawn:GetWorld():GetFullName()
                worldName = full:match("([%w_]+)$") or full
            end)
        end
    end
end

-- ==================== Position collection ====================

local function CollectPositions()
    local players = {}
    for index, entry in ipairs(pawnCache) do
        local pawn = entry.pawn
        if pawn:IsValid() then
            local okLoc, location = pcall(function() return pawn:K2_GetActorLocation() end)
            local okRot, rotation = pcall(function() return pawn:K2_GetActorRotation() end)
            if okLoc and location then
                local isDead = false
                pcall(function() isDead = pawn.IsDead == true end)
                players[#players + 1] = {
                    id = tostring(index),
                    name = entry.name,
                    x = location.X,
                    y = location.Y,
                    z = location.Z,
                    yaw = (okRot and rotation) and rotation.Yaw or 0,
                    isLocal = entry.isLocal,
                    isDead = isDead,
                }
            end
        end
    end
    if #players == 0 then
        return nil
    end
    return { world = worldName, players = players }
end

-- ==================== Rat Scanner detection ====================
-- The held item is the pawn's direct ItemInHand_BP property. Many AF items
-- share one blueprint class and differ only by their data-table RowName, so we
-- match the config substring against several identifiers: the class name, the
-- actor full name AND the item's RowName. If require_rat_scanner is false this
-- check is never called at all.

local heldItemLogThrottle = 0

-- Collect every identifier string of the currently held item (each guarded,
-- so a missing property never breaks the others).
local function HeldItemIds(pawn)
    local ids = {}
    local item = pawn.ItemInHand_BP
    if not item or not item:IsValid() then return ids end
    pcall(function() ids[#ids + 1] = item:GetClass():GetFullName() end)
    pcall(function() ids[#ids + 1] = item:GetFullName() end)
    pcall(function() ids[#ids + 1] = item.ItemDataRow.RowName:ToString() end)
    pcall(function() ids[#ids + 1] = item.ItemData.ItemName:ToString() end)
    return ids
end

local function MaybeLogHeldItem(ids)
    if not LOG_HELD_ITEM then return end
    heldItemLogThrottle = heldItemLogThrottle + 1
    if heldItemLogThrottle < 20 then return end -- ~every 2s at 100ms tick
    heldItemLogThrottle = 0
    if #ids > 0 then
        Log(T("held_item", table.concat(ids, "  |  ")))
    else
        Log(T("held_item", "<nothing in hand / not readable>"))
    end
end

local function IsHoldingScanner(pawn)
    local match = false
    pcall(function()
        local ids = HeldItemIds(pawn)
        MaybeLogHeldItem(ids)
        for _, id in ipairs(ids) do
            if id:lower():find(SCANNER_ITEM_MATCH, 1, true) then
                match = true
                return
            end
        end
    end)
    return match
end

-- ==================== Lidar ====================

local kismetSystemLibrary = nil

local function GetKSL()
    if not kismetSystemLibrary or not kismetSystemLibrary:IsValid() then
        kismetSystemLibrary = UEHelpers.GetKismetSystemLibrary()
    end
    return kismetSystemLibrary
end

-- Global golden spiral: rayIndex grows forever, directions evenly cover the
-- sphere over any time window.
local GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))
local SPIRAL_PERIOD = 240
local rayIndex = 0
local blackColor = { R = 0, G = 0, B = 0, A = 0 }

local function CollectLidar(localPawn)
    local ksl = GetKSL()
    if not ksl or not ksl:IsValid() then return nil end

    local controller = UEHelpers.GetPlayerController()
    if not controller or not controller:IsValid() then return nil end
    local camera = controller.PlayerCameraManager
    if not camera or not camera:IsValid() then return nil end

    local cameraLocation = camera:GetCameraLocation()
    local origin = { X = cameraLocation.X, Y = cameraLocation.Y, Z = cameraLocation.Z }

    local points = {}
    for _ = 1, SCAN_RAYS do
        local cyclePos = (rayIndex % SPIRAL_PERIOD + 0.5) / SPIRAL_PERIOD
        local dz = 1.0 - 2.0 * cyclePos
        local radius = math.sqrt(math.max(0.0, 1.0 - dz * dz))
        local phi = rayIndex * GOLDEN_ANGLE
        rayIndex = rayIndex + 1

        local endPoint = {
            X = origin.X + math.cos(phi) * radius * SCAN_RANGE,
            Y = origin.Y + math.sin(phi) * radius * SCAN_RANGE,
            Z = origin.Z + dz * SCAN_RANGE,
        }
        local hitResult = {}
        local wasHit = ksl:LineTraceSingle(
            localPawn,        -- WorldContextObject
            origin,
            endPoint,
            0,                -- ETraceTypeQuery: TraceTypeQuery1 = Visibility
            false,            -- bTraceComplex
            {},               -- ActorsToIgnore
            0,                -- EDrawDebugTrace: None
            hitResult,        -- out FHitResult
            true,             -- bIgnoreSelf
            blackColor, blackColor, 0.0
        )
        if wasHit and hitResult.Location then
            local distance = hitResult.Distance or SCAN_RANGE
            if distance > SCAN_MIN_DISTANCE then
                points[#points + 1] = {
                    math.floor(hitResult.Location.X + 0.5),
                    math.floor(hitResult.Location.Y + 0.5),
                    math.floor(hitResult.Location.Z + 0.5),
                }
            end
        end
    end

    if #points == 0 then return nil end
    -- origin lets the server "carve" empty space along the rays (regeneration)
    return {
        origin = { math.floor(origin.X + 0.5), math.floor(origin.Y + 0.5), math.floor(origin.Z + 0.5) },
        points = points,
    }
end

-- ==================== Main loop ====================
-- The game thread only fills pendingState/pendingLidar (raw tables); the
-- LoopAsync background thread encodes JSON and writes the files.

local pendingState = nil
local pendingLidar = nil
local stateSeq = 0
local scanSeq = 0
local lidarErrorLogged = false

local function CollectOnGameThread()
    if ticksSinceRefresh >= CACHE_REFRESH_TICKS then
        ticksSinceRefresh = 0
        RefreshPawnCache()
    end
    ticksSinceRefresh = ticksSinceRefresh + 1

    pendingState = CollectPositions()

    if SCAN_ENABLED and pendingState then
        local localEntry = nil
        for _, entry in ipairs(pawnCache) do
            if entry.isLocal and entry.pawn:IsValid() then
                localEntry = entry
                break
            end
        end
        if not localEntry and pawnCache[1] and pawnCache[1].pawn:IsValid() then
            localEntry = pawnCache[1]
        end
        -- Item gate: scan only while holding the Rat Scanner (if enabled)
        local allowScan = localEntry ~= nil
        if allowScan and REQUIRE_RAT_SCANNER then
            allowScan = IsHoldingScanner(localEntry.pawn)
        end
        if allowScan then
            local ok, result = pcall(CollectLidar, localEntry.pawn)
            if ok then
                pendingLidar = result
            elseif not lidarErrorLogged then
                lidarErrorLogged = true
                Log(T("lidar_error", tostring(result)))
            end
        elseif LOG_HELD_ITEM and localEntry then
            -- Keep the held-item diagnostic working even when the gate blocks scanning
            IsHoldingScanner(localEntry.pawn)
        end
    end
end

local function WriteFile(path, content)
    local file = io.open(path, "w")
    if not file then return end
    file:write(content)
    file:close()
end

Log(T("mod_loaded", INTERVAL_MS, SCAN_RAYS,
    REQUIRE_RAT_SCANNER and T("scan_gated") or T("scan_always")))

LoopAsync(INTERVAL_MS, function()
    -- 1. Background thread: encode and write what the previous tick gathered
    if pendingState then
        stateSeq = stateSeq + 1
        pendingState.seq = stateSeq
        WriteFile(OUTPUT_FILE, JsonEncode(pendingState))
        pendingState = nil
    end
    if pendingLidar then
        scanSeq = scanSeq + 1
        WriteFile(SCAN_FILE, JsonEncode({
            seq = scanSeq,
            world = worldName,
            origin = pendingLidar.origin,
            points = pendingLidar.points,
        }))
        pendingLidar = nil
    end

    -- 2. Game thread: light data gathering for the next write
    ExecuteInGameThread(function()
        local ok, err = pcall(CollectOnGameThread)
        if not ok then
            Log(T("collect_error", tostring(err)))
        end
    end)
    return false -- false = keep the loop going
end)
