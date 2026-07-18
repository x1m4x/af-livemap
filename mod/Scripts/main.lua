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

-- Base class every character derives from (players, NPCs, traders, creatures)
local CHARACTER_CLASS = "Abiotic_Character_ParentBP_C"

-- Trader auto-detection. We don't know the traders' blueprint class names, but
-- their in-game names are known, so we match a distinctive token against the
-- actor/class identifiers. Traveling traders are only reported while the
-- Employee Locator trinket is worn (see LOCATOR_MATCH).
local DETECT_TRADERS = true
local TRADERS = {
    { token = "bunning",    name = "Warren Bunning" },
    { token = "isling",     name = "Grayson Isling" },
    { token = "marion",     name = "Marion" },
    { token = "blacksmith", name = "The Blacksmith" },
    { token = "larva",      name = "Big Hive Larva" },
    { token = "carson",     name = "Dr. Carson" },
    { token = "sanders",    name = "Jimmy Sanders" },
    { token = "thule",      name = "Dr. Ulrich Thule" },
}
local LOCATOR_MATCH = "employeelocator"
-- Diagnostics: log every non-player character's identifiers once per refresh,
-- so unmatched traders can be found. Toggled in config.txt (log_npcs).
local LOG_NPCS = false

-- Lidar: rays per tick. 12 x 10 ticks/s = 120 rays/s spread across frames.
local SCAN_ENABLED = true
local SCAN_RAYS = 12
local SCAN_RANGE = 6000.0       -- ray range, cm (60 m)
local SCAN_MIN_DISTANCE = 60.0  -- closer than this = own body/held item, noise
local SCAN_CONE_DEG = 0         -- 0 = full sphere; >0 = cone around the view
local SCAN_CONE_COS = -1.0      -- cos(cone/2), recomputed when config loads

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
        equip_read_failed = "Could not read equipment slots - Employee Locator gating disabled",
        npc_seen         = "NPC: %s",
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
        equip_read_failed = "Не удалось прочитать слоты экипировки - гейт по Employee Locator отключён",
        npc_seen         = "NPC: %s",
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
            elseif key == "scan_cone_deg" then
                SCAN_CONE_DEG = tonumber(value) or SCAN_CONE_DEG
            elseif key == "log_held_item" then
                LOG_HELD_ITEM = ParseBool(value, LOG_HELD_ITEM)
            elseif key == "language" then
                if #value > 0 then LANGUAGE = value:lower() end
            elseif key == "detect_traders" then
                DETECT_TRADERS = ParseBool(value, DETECT_TRADERS)
            elseif key == "log_npcs" then
                LOG_NPCS = ParseBool(value, LOG_NPCS)
            end
        end
    end
    file:close()
    -- Clamp to a sane range; anything >= 360 is just the full sphere again
    if SCAN_CONE_DEG and SCAN_CONE_DEG > 0 then
        if SCAN_CONE_DEG < 10 then SCAN_CONE_DEG = 10 end
        if SCAN_CONE_DEG >= 360 then SCAN_CONE_DEG = 0 end
    else
        SCAN_CONE_DEG = 0
    end
    SCAN_CONE_COS = (SCAN_CONE_DEG > 0) and math.cos(math.rad(SCAN_CONE_DEG / 2)) or -1.0
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
    local state = { world = worldName, players = players }
    if DETECT_TRADERS then
        state.traders = traderCache          -- авто-найденные торговцы
        state.locator = locatorEquipped      -- надет ли Employee Locator
    end
    return state
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

-- ==================== Trader detection ====================
-- Refreshed on the same cadence as the pawn cache (FindAllOf is costly).

local traderCache = {}       -- {name, x, y, z}
local locatorEquipped = false
local equipReadFailed = false

local function Normalize(s)
    return (s:lower():gsub("[^a-z0-9]", ""))
end

-- Employee Locator sits in a trinket slot. Gear slots (Lua 1-based):
-- Trinket = 8, Trinket2 = 12 (AFUtils.GearInventoryIndex).
local ITEM_ROW_FIELD = "ItemDataTable_18_BF1052F141F66A976F4844AB2B13062B"

local function IsLocatorEquipped(pawn)
    local found = false
    local ok = pcall(function()
        local gear = pawn.CharacterEquipSlotInventory
        if not gear or not gear:IsValid() then return end
        local slots = gear.CurrentInventory
        if not slots then return end
        for _, index in ipairs({ 8, 12 }) do
            if #slots >= index then
                local row = nil
                pcall(function()
                    row = slots[index][ITEM_ROW_FIELD].RowName:ToString()
                end)
                if row and Normalize(row):find(LOCATOR_MATCH, 1, true) then
                    found = true
                end
            end
        end
    end)
    if not ok and not equipReadFailed then
        equipReadFailed = true
        Log(T("equip_read_failed"))
    end
    return found
end

-- Identifiers of a character we can match trader names against
local function CharacterIds(ch)
    local ids = {}
    pcall(function() ids[#ids + 1] = ch:GetClass():GetFullName() end)
    pcall(function() ids[#ids + 1] = ch:GetFullName() end)
    return ids
end

local function RefreshTraderCache(localPawn)
    traderCache = {}
    if not DETECT_TRADERS then return end

    locatorEquipped = localPawn and IsLocatorEquipped(localPawn) or false

    local chars = FindAllOf(CHARACTER_CLASS)
    if not chars then return end

    for _, ch in ipairs(chars) do
        if ch:IsValid() then
            local ids = CharacterIds(ch)
            local blob = Normalize(table.concat(ids, " "))
            if not blob:find("playercharacter", 1, true) then
                if LOG_NPCS and #ids > 0 then
                    Log(T("npc_seen", ids[1]))
                end
                for _, trader in ipairs(TRADERS) do
                    if blob:find(trader.token, 1, true) then
                        local okLoc, loc = pcall(function() return ch:K2_GetActorLocation() end)
                        if okLoc and loc then
                            traderCache[#traderCache + 1] = {
                                name = trader.name,
                                x = loc.X, y = loc.Y, z = loc.Z,
                            }
                        end
                        break
                    end
                end
            end
        end
    end
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

    -- Cone mode: aim the spiral at where the player looks instead of spraying
    -- the whole sphere. Angular density is fixed, so full-sphere hits drift
    -- ~7 m apart at 30 m; a 60 deg cone packs the same rays ~4x tighter, which
    -- is what makes large rooms practical to map.
    local fwd, right, up
    if SCAN_CONE_DEG > 0 then
        local rot = camera:GetCameraRotation()
        local p = math.rad(rot.Pitch)
        local y = math.rad(rot.Yaw)
        local cp = math.cos(p)
        fwd = { X = cp * math.cos(y), Y = cp * math.sin(y), Z = math.sin(p) }
        -- Any basis perpendicular to fwd works (the cone is symmetric); switch
        -- the reference axis when looking almost straight up/down.
        local ref = (math.abs(fwd.Z) < 0.99) and { X = 0, Y = 0, Z = 1 } or { X = 1, Y = 0, Z = 0 }
        right = {
            X = ref.Y * fwd.Z - ref.Z * fwd.Y,
            Y = ref.Z * fwd.X - ref.X * fwd.Z,
            Z = ref.X * fwd.Y - ref.Y * fwd.X,
        }
        local rl = math.sqrt(right.X * right.X + right.Y * right.Y + right.Z * right.Z)
        if rl < 1e-6 then rl = 1 end
        right.X, right.Y, right.Z = right.X / rl, right.Y / rl, right.Z / rl
        up = {
            X = fwd.Y * right.Z - fwd.Z * right.Y,
            Y = fwd.Z * right.X - fwd.X * right.Z,
            Z = fwd.X * right.Y - fwd.Y * right.X,
        }
    end

    local points = {}
    for _ = 1, SCAN_RAYS do
        local cyclePos = (rayIndex % SPIRAL_PERIOD + 0.5) / SPIRAL_PERIOD
        local phi = rayIndex * GOLDEN_ANGLE
        rayIndex = rayIndex + 1

        local dirX, dirY, dirZ
        if fwd then
            -- dz spans [cos(half), 1] -> the spiral fills a disc around fwd
            local dz = 1.0 - cyclePos * (1.0 - SCAN_CONE_COS)
            local radius = math.sqrt(math.max(0.0, 1.0 - dz * dz))
            local lx = math.cos(phi) * radius
            local ly = math.sin(phi) * radius
            dirX = right.X * lx + up.X * ly + fwd.X * dz
            dirY = right.Y * lx + up.Y * ly + fwd.Y * dz
            dirZ = right.Z * lx + up.Z * ly + fwd.Z * dz
        else
            local dz = 1.0 - 2.0 * cyclePos
            local radius = math.sqrt(math.max(0.0, 1.0 - dz * dz))
            dirX = math.cos(phi) * radius
            dirY = math.sin(phi) * radius
            dirZ = dz
        end

        local endPoint = {
            X = origin.X + dirX * SCAN_RANGE,
            Y = origin.Y + dirY * SCAN_RANGE,
            Z = origin.Z + dirZ * SCAN_RANGE,
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
        -- Торговцы обновляются на том же такте: FindAllOf дорогой
        local localPawn = UEHelpers.GetPlayer()
        pcall(RefreshTraderCache, (localPawn and localPawn:IsValid()) and localPawn or nil)
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
