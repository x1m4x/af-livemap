// AF LiveMap — localization (en/ru).
// Language: saved choice in localStorage, otherwise auto from browser language.
// t(key, params) returns a string; templates use {name} placeholders.

"use strict";

const I18N = (() => {
  const STRINGS = {
    en: {
      // topbar / static
      world_title: "World",
      follow: "Follow",
      trail: "Trail",
      add_waypoint: "+ Marker",
      add_waypoint_title: "Place a marker at the player's position",
      elevator: "Elevator",
      elevator_title: "Record an elevator: press in the cabin, ride all floors, press again",
      cart: "Cart",
      cart_title: "Record a cart: press when seated, ride to the end, press again",
      waypoints_btn: "Markers",
      images_btn: "Maps",
      notes_btn: "Notes",
      status_waiting: "waiting…",
      no_portal_btn: "🚫 'No-portal' zone here",
      no_portal_title: "Teleports into this zone won't be recorded as portals",
      close: "Close",
      notes_placeholder: "Notes: coordinates, plans, what's where… Saved on the server and visible on PC and phone.",
      image_alt: "Sector map",
      lang_title: "Language",

      // worlds / status
      world_player_here: " (player here)",
      status_connected: "connected",
      status_online: "online: {n} | world: {world}",
      status_viewing: " | viewing: {world}",
      status_no_connection: "no server connection…",

      // generic buttons
      route_btn: "Route",
      stop_btn: "Stop",
      route_title: "Build a route",
      delete_btn: "Delete",
      rename_btn_title: "Rename",
      show_on_map: "Show on map",

      // rename
      rename_prompt: "New name:",
      rename_failed: "Server rejected the rename — restart server.py (you have an old version).",

      // waypoints
      no_waypoints: "No markers in this world. \"+ Marker\" places one where you stand.",
      confirm_delete_waypoint: "Delete marker \"{name}\"?",
      waypoint_prompt: "Marker name:",
      no_player_data: "No player position data — join the game.",

      // elevators
      elevator_label: "⬍ {name} ({n} fl.{doors})",
      elevator_doors_suffix: ", doors",
      confirm_delete_elevator: "Delete \"{name}\"? The zone will be scanned again.",
      elevator_btn_stop_stops: "Stop ({n} stops)",
      elevator_btn_stop_zero: "Stop (0 stops)",
      elevator_too_short: "Recording too short — stand in the elevator, press \"Elevator\", ride all floors and press again.",
      elevator_few_stops: "Only {n} stop found. Ride all floors, pausing at least a couple of seconds on each.",
      elevator_too_far: "You went far from the elevator while recording — recording cancelled. Stay in the cabin.",
      elevator_prompt: "Elevator with {n} stops. Name:",
      elevator_default_name: "Elevator {n}",
      elevator_doors_confirm: "Does this elevator have closing doors?\nOK — yes, Cancel — open platform.",
      elevator_saved: "Elevator saved: {n} stops. Cleared {cells} junk scan cells.",
      elevator_save_failed: "Could not save the elevator: ",
      elevator_map_label: "{name} ({n} fl.)",

      // carts
      cart_label: "⛟ {name} ({m} m)",
      cart_start_name: "{name} (start)",
      cart_end_name: "{name} (end)",
      confirm_delete_cart: "Delete \"{name}\"?",
      cart_btn_stop: "Stop ({m} m)",
      cart_btn_stop_zero: "Stop (0 m)",
      cart_too_short: "Recording too short — sit in the cart, press \"Cart\", ride to the end and press again.",
      cart_prompt: "Cart route: {m} m. Name:",
      cart_default_name: "Cart {n}",
      cart_default_base: "Cart",

      // portals
      portal_exit_prefix: "exit: ",
      portal_name_cross: "Portal → {world}",
      portal_name: "Portal",
      portal_uses: "traveled ×{n}",
      portal_uses_title: "How many times you traveled through this portal",
      floor3d_floor: "Floor ±5 m",
      floor3d_all: "Whole map",
      floor3d_title: "3D: highlight your floor (rest ghosted) or show everything equally",
      new_portal_console: "New portal detected:",
      confirm_delete_portal: "Delete \"{name}\"? (false hits — e.g. after death — delete freely)",

      // no-portal zones
      zone_label: "🚫 {name} (no-portal, {m} m)",
      confirm_delete_zone: "Delete zone \"{name}\"? Teleports here will be recorded as portals again.",
      zone_created: "Zone \"{name}\" created ({m} m). Old portals removed: {purged}.",
      no_player_base: "No player position data — join the game and stand at your base.",
      zone_name_prompt: "Zone name (e.g. \"Base\"):",
      zone_radius_prompt: "Zone radius, m:",
      zone_default_name: "Base",

      // routes
      route_need_player_world: "Routing is available while viewing the world the player is in.",
      route_target_other_world: "Marker is in world \"{world}\", no known portal there — walk through one once.",
      route_via_portal: " → then via \"{name}\"",
      route_no_floor: "No scanned floor nearby — look around.",
      route_not_found: "Path not found: the route isn't scanned yet. Walk and look along the way once.",
      route_to: "Route to \"{name}\": {m} m{hint}",

      // misc
      save_failed: "Could not save: ",
      webgl_error: "WebGL unavailable: ",
      webgl_unavailable: "WebGL is unavailable in this browser.",
      coords: "{x}, {y} m | zoom: {zoom}",
      hud_distance: "{name} ({dist} m)",

      // traders
      add_trader: "+ Trader",
      add_trader_title: "Save the trader you're standing next to",
      pick_trader: "Which trader is this? (saved at your position)",
      add_btn: "Add",
      cancel_btn: "Cancel",
      trader_label: "🛒 {name}",
      confirm_delete_trader: "Delete trader \"{name}\"?",
      trader_sells_nothing: "No trade data for this trader.",
      trader_unlock: "Unlocked: {text}",

      // notes
      notes_synced: "synced",
      notes_server_down: "server unavailable",
      notes_saving: "saving…",
      notes_saved: "saved",
      notes_save_error: "save error",
      notes_not_saved: "server unavailable — changes not saved",
      notes_typing: "typing…",
      notes_updated: "updated from another device",
    },
    ru: {
      world_title: "Мир",
      follow: "Следовать",
      trail: "След",
      add_waypoint: "+ Точка",
      add_waypoint_title: "Поставить точку на месте игрока",
      elevator: "Лифт",
      elevator_title: "Записать лифт: нажми в кабине, прокатись по всем этажам, нажми ещё раз",
      cart: "Тележка",
      cart_title: "Записать тележку: нажми сев в неё, доедь до конца, нажми ещё раз",
      waypoints_btn: "Точки",
      images_btn: "Карты",
      notes_btn: "Заметки",
      status_waiting: "ожидание…",
      no_portal_btn: "🚫 Зона «не портал» здесь",
      no_portal_title: "Телепорты в эту зону не будут записываться как порталы",
      close: "Закрыть",
      notes_placeholder: "Заметки: координаты, планы, что где лежит… Сохраняются на сервере и видны с ПК и телефона.",
      image_alt: "Карта сектора",
      lang_title: "Язык",

      world_player_here: " (тут игрок)",
      status_connected: "подключено",
      status_online: "онлайн: {n} | мир: {world}",
      status_viewing: " | просмотр: {world}",
      status_no_connection: "нет связи с сервером…",

      route_btn: "Маршрут",
      stop_btn: "Стоп",
      route_title: "Построить маршрут",
      delete_btn: "Удалить",
      rename_btn_title: "Переименовать",
      show_on_map: "Показать на карте",

      rename_prompt: "Новое название:",
      rename_failed: "Сервер не принял переименование — перезапусти server.py (у тебя старая версия).",

      no_waypoints: "Точек в этом мире нет. «+ Точка» ставит точку там, где ты стоишь.",
      confirm_delete_waypoint: "Удалить точку «{name}»?",
      waypoint_prompt: "Название точки:",
      no_player_data: "Нет данных о позиции игрока — зайди в игру.",

      elevator_label: "⬍ {name} ({n} эт.{doors})",
      elevator_doors_suffix: ", двери",
      confirm_delete_elevator: "Удалить «{name}»? Зона снова начнёт сканироваться.",
      elevator_btn_stop_stops: "Стоп ({n} ост.)",
      elevator_btn_stop_zero: "Стоп (0 ост.)",
      elevator_too_short: "Слишком короткая запись — встань в лифт, нажми «Лифт», прокатись по всем этажам и нажми ещё раз.",
      elevator_few_stops: "Найдено остановок: {n}. Прокатись по всем этажам, задерживаясь на каждом хотя бы пару секунд.",
      elevator_too_far: "Во время записи ты уходил далеко от лифта — запись отменена. Оставайся в кабине.",
      elevator_prompt: "Лифт с {n} остановками. Название:",
      elevator_default_name: "Лифт {n}",
      elevator_doors_confirm: "У этого лифта есть закрывающиеся двери?\nОК — да, Отмена — открытая платформа.",
      elevator_saved: "Лифт сохранён: {n} остановок. Вычищено {cells} мусорных ячеек скана.",
      elevator_save_failed: "Не удалось сохранить лифт: ",
      elevator_map_label: "{name} ({n} эт.)",

      cart_label: "⛟ {name} ({m} м)",
      cart_start_name: "{name} (начало)",
      cart_end_name: "{name} (конец)",
      confirm_delete_cart: "Удалить «{name}»?",
      cart_btn_stop: "Стоп ({m} м)",
      cart_btn_stop_zero: "Стоп (0 м)",
      cart_too_short: "Слишком короткая запись — сядь в тележку, нажми «Тележка», доедь до конца и нажми ещё раз.",
      cart_prompt: "Маршрут тележки: {m} м. Название:",
      cart_default_name: "Тележка {n}",
      cart_default_base: "Тележка",

      portal_exit_prefix: "выход: ",
      portal_name_cross: "Портал → {world}",
      portal_name: "Портал",
      portal_uses: "переходов: {n}",
      portal_uses_title: "Сколько раз ты прошёл через этот портал",
      floor3d_floor: "Этаж ±5 м",
      floor3d_all: "Вся карта",
      floor3d_title: "3D: подсветить твой этаж (остальное призраком) или всё одинаково",
      new_portal_console: "Обнаружен новый портал:",
      confirm_delete_portal: "Удалить «{name}»? (ложные срабатывания — например, после смерти — удаляй смело)",

      zone_label: "🚫 {name} (не портал, {m} м)",
      confirm_delete_zone: "Удалить зону «{name}»? Телепорты сюда снова начнут записываться как порталы.",
      zone_created: "Зона «{name}» создана ({m} м). Удалено старых порталов: {purged}.",
      no_player_base: "Нет данных о позиции игрока — зайди в игру и встань на базе.",
      zone_name_prompt: "Название зоны (например, «База»):",
      zone_radius_prompt: "Радиус зоны, м:",
      zone_default_name: "База",

      route_need_player_world: "Маршрут доступен, когда смотришь мир, где находится игрок.",
      route_target_other_world: "Точка в мире «{world}», известного портала туда нет — пройди через него один раз.",
      route_via_portal: " → дальше через «{name}»",
      route_no_floor: "Рядом нет отсканированного пола — осмотрись вокруг.",
      route_not_found: "Путь не найден: маршрут ещё не отсканирован. Пройди и осмотри дорогу один раз.",
      route_to: "Маршрут до «{name}»: {m} м{hint}",

      save_failed: "Не удалось сохранить: ",
      webgl_error: "WebGL недоступен: ",
      webgl_unavailable: "WebGL недоступен в этом браузере.",
      coords: "{x}, {y} м | zoom: {zoom}",
      hud_distance: "{name} ({dist} м)",

      add_trader: "+ Торговец",
      add_trader_title: "Сохранить торговца, рядом с которым ты стоишь",
      pick_trader: "Какой это торговец? (сохранится на твоей позиции)",
      add_btn: "Добавить",
      cancel_btn: "Отмена",
      trader_label: "🛒 {name}",
      confirm_delete_trader: "Удалить торговца «{name}»?",
      trader_sells_nothing: "Нет данных об обменах для этого торговца.",
      trader_unlock: "Открывается: {text}",

      notes_synced: "синхронизировано",
      notes_server_down: "сервер недоступен",
      notes_saving: "сохранение…",
      notes_saved: "сохранено",
      notes_save_error: "ошибка сохранения",
      notes_not_saved: "сервер недоступен — правки не сохранены",
      notes_typing: "печатаешь…",
      notes_updated: "обновлено с другого устройства",
    },
  };

  let lang = "en";

  function detect() {
    const saved = localStorage.getItem("af_lang");
    if (saved === "en" || saved === "ru") { lang = saved; return; }
    const nav = (navigator.language || "en").toLowerCase();
    lang = nav.startsWith("ru") ? "ru" : "en";
  }

  function t(key, params) {
    let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
    if (params) {
      for (const k in params) s = s.split("{" + k + "}").join(String(params[k]));
    }
    return s;
  }

  // Apply to static elements marked with data-i18n / -title / -placeholder / -alt
  function applyStatic() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-i18n]").forEach(el => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.querySelectorAll("[data-i18n-title]").forEach(el => {
      el.title = t(el.getAttribute("data-i18n-title"));
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.querySelectorAll("[data-i18n-alt]").forEach(el => {
      el.alt = t(el.getAttribute("data-i18n-alt"));
    });
  }

  function setLang(value) {
    localStorage.setItem("af_lang", value);
    location.reload();
  }

  detect();
  return { t, applyStatic, setLang, get lang() { return lang; } };
})();

const t = I18N.t;
