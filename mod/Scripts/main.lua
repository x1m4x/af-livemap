-- AFLiveMap: пишет позиции игроков и лидар-скан в JSON-файлы для локальной live-карты.
-- Устанавливается в: <игра>\AbioticFactor\Binaries\Win64\ue4ss\Mods\AFLiveMap\Scripts\main.lua
-- Читается сервером: server/server.py --data <путь к livemap.json>
--
-- Производительность: в игровом потоке выполняется только сбор данных
-- (несколько трейсов и чтение позиций), кодирование JSON и запись файлов
-- происходят в фоновом потоке LoopAsync — игровые кадры не блокируются диском.

local UEHelpers = require("UEHelpers")

-- ==================== Настройки по умолчанию ====================
-- Значения ниже — дефолты. Их можно переопределить, не трогая код, в файле
-- config.txt рядом с этим модом (см. секцию «Конфиг» ниже).

-- Интервал тика, мс. Чаще, но с малой порцией работы — вместо редких тяжёлых пиков.
local INTERVAL_MS = 100

-- Файлы вывода. Относительный путь считается от <игра>\AbioticFactor\Binaries\Win64\
local MOD_DIR = "ue4ss\\Mods\\AFLiveMap\\"
local OUTPUT_FILE = MOD_DIR .. "livemap.json"
local SCAN_FILE = MOD_DIR .. "lidar.json"
local CONFIG_FILE = MOD_DIR .. "config.txt"

-- Класс пешки игрока в Abiotic Factor (blueprint-класс персонажа)
local PLAYER_CLASS = "Abiotic_PlayerCharacter_C"

-- Лидар: лучей за тик. 12 x 10 тик/с = 120 лучей/с, размазанных по кадрам.
local SCAN_ENABLED = true
local SCAN_RAYS = 12
local SCAN_RANGE = 6000.0       -- дальность луча, см (60 м)
local SCAN_MIN_DISTANCE = 60.0  -- ближе — своё тело/предмет в руках, шум

-- Привязка сканирования к предмету Rat Scanner.
-- require_rat_scanner = true  → карта строится ТОЛЬКО когда держишь Rat Scanner в руке.
-- require_rat_scanner = false → сканирование работает всегда, без предмета.
local REQUIRE_RAT_SCANNER = true
-- Подстрока имени предмета в руке для опознания сканера (регистр игнорируется).
local SCANNER_ITEM_MATCH = "ratscanner"
-- Диагностика: печатать в консоль имя предмета в руке (чтобы узнать точное имя
-- для scanner_item_match, если детект не срабатывает). Включается в config.txt.
local LOG_HELD_ITEM = false

-- Обновление кэша пешек (FindAllOf — дорогой, не зовём каждый тик), в тиках
local CACHE_REFRESH_TICKS = 30  -- раз в ~3 секунды

-- ===============================================================

local function Log(message)
    print(string.format("[AFLiveMap] %s\n", message))
end

-- ==================== Конфиг ====================
-- Простой текстовый config.txt формата key=value рядом с модом. Отсутствие
-- файла — не ошибка: работают дефолты выше. Игрок редактирует только config.txt.

local function ParseBool(value, fallback)
    value = value:lower()
    if value == "true" or value == "1" or value == "yes" or value == "on" then return true end
    if value == "false" or value == "0" or value == "no" or value == "off" then return false end
    return fallback
end

local function LoadConfig()
    local file = io.open(CONFIG_FILE, "r")
    if not file then
        Log("config.txt не найден — работают настройки по умолчанию")
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
            end
        end
    end
    file:close()
    Log(string.format("config.txt загружен: require_rat_scanner=%s, match='%s'",
        tostring(REQUIRE_RAT_SCANNER), SCANNER_ITEM_MATCH))
end

LoadConfig()

-- Минимальный JSON-энкодер: достаточно чисел, строк, bool, массивов и объектов
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

-- ==================== Кэш пешек ====================
-- FindAllOf, имена игроков и имя мира обновляются редко;
-- каждый тик читаются только позиции.

local pawnCache = {}   -- массив {pawn, name, isLocal}
local worldName = "unknown"
local ticksSinceRefresh = 1000 -- обновить на первом же тике

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

-- ==================== Сбор позиций ====================

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

-- ==================== Опознание Rat Scanner ====================
-- Предмет в руке — прямое свойство пешки ItemInHand_BP. Сверяем имя его
-- blueprint-класса с подстрокой из конфига. Если require_rat_scanner=false,
-- проверка не вызывается вовсе.

local heldItemLogThrottle = 0

local function IsHoldingScanner(pawn)
    local match = false
    pcall(function()
        local item = pawn.ItemInHand_BP
        if item and item:IsValid() then
            local className = item:GetClass():GetFullName()
            if LOG_HELD_ITEM then
                heldItemLogThrottle = heldItemLogThrottle + 1
                if heldItemLogThrottle >= 20 then -- ~раз в 2 сек при тике 100 мс
                    heldItemLogThrottle = 0
                    Log("Предмет в руке: " .. tostring(className))
                end
            end
            if className:lower():find(SCANNER_ITEM_MATCH, 1, true) then
                match = true
            end
        end
    end)
    return match
end

-- ==================== Лидар ====================

local kismetSystemLibrary = nil

local function GetKSL()
    if not kismetSystemLibrary or not kismetSystemLibrary:IsValid() then
        kismetSystemLibrary = UEHelpers.GetKismetSystemLibrary()
    end
    return kismetSystemLibrary
end

-- Глобальная золотая спираль: rayIndex растёт бесконечно, направления
-- равномерно покрывают сферу на любом окне времени.
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
    -- origin нужен серверу для «вырезания» пустоты вдоль лучей (перегенерация)
    return {
        origin = { math.floor(origin.X + 0.5), math.floor(origin.Y + 0.5), math.floor(origin.Z + 0.5) },
        points = points,
    }
end

-- ==================== Главный цикл ====================
-- Игровой поток только заполняет pendingState/pendingLidar (сырые таблицы),
-- фоновый поток LoopAsync кодирует JSON и пишет файлы.

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
        -- Гейт по предмету: сканируем только с Rat Scanner в руке (если включено)
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
                Log("Лидар не работает: " .. tostring(result))
            end
        elseif LOG_HELD_ITEM and localEntry then
            -- Дать диагностике имени предмета работать даже когда скан выключен гейтом
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

Log(string.format("Мод загружен: тик %d мс, лидар %d лучей/тик, %s",
    INTERVAL_MS, SCAN_RAYS,
    REQUIRE_RAT_SCANNER and "скан только с Rat Scanner в руке" or "скан всегда включён"))

LoopAsync(INTERVAL_MS, function()
    -- 1. Фоновый поток: кодируем и пишем то, что собрал предыдущий тик
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

    -- 2. Игровой поток: лёгкий сбор данных для следующей записи
    ExecuteInGameThread(function()
        local ok, err = pcall(CollectOnGameThread)
        if not ok then
            Log("Ошибка сбора: " .. tostring(err))
        end
    end)
    return false -- false = продолжать цикл
end)
