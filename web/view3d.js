// AF LiveMap — 3D-вид облака точек на чистом WebGL (без библиотек).
// Мировые оси UE: X/Y — горизонталь, Z — вверх. Координаты в метрах (см / 100).
// Камера орбитальная: ЛКМ — вращение, колесо — приближение, ПКМ/Shift+ЛКМ — панорама.

"use strict";

const View3D = (() => {
  // Фон сцены — участвует в тумане и «призрачности» этажей
  const BG = [0.05, 0.07, 0.09];

  const VERTEX_SHADER = `
    attribute vec3 aPos;
    attribute vec3 aColor;
    uniform mat4 uMvp;
    uniform float uPointScale;
    uniform float uMaxSize;
    uniform vec3 uPlayerPos;
    uniform float uUseDistance;
    uniform float uFloorFocus;  // 1 = подсветить этаж игрока, остальное призраком
    uniform float uFogFar;      // м: дальше этого — полный туман
    uniform float uGhostPass;   // -1 = все точки, 0 = только яркие, 1 = только призраки
    varying vec3 vColor;
    varying float vDepth;       // линейная глубина 0..1 — для EDL-подсветки
    varying float vDrop;        // 1 = точка не этого прохода, выбросить
    void main() {
      gl_Position = uMvp * vec4(aPos, 1.0);
      float w = max(gl_Position.w, 0.1);
      float size = uPointScale / w;
      gl_PointSize = clamp(size, 1.0, uMaxSize);
      // Цвет по расстоянию от игрока: тёплое близко -> зелёное -> синее далеко.
      // Считается в шейдере, поэтому перекрашивается на лету при движении.
      float d = distance(aPos, uPlayerPos);
      float t = clamp(d / 40.0, 0.0, 1.0);
      vec3 cNear = vec3(1.0, 0.62, 0.25);
      vec3 cMid  = vec3(0.45, 0.85, 0.5);
      vec3 cFar  = vec3(0.4, 0.5, 1.0);
      vec3 distColor = t < 0.5 ? mix(cNear, cMid, t * 2.0) : mix(cMid, cFar, t * 2.0 - 1.0);
      vec3 color = mix(aColor, distColor, uUseDistance);
      // Режим этажа: вне ±5 м от высоты игрока точки почти сливаются с фоном,
      // но остаются видимым контекстом здания (не скрываются совсем)
      float ghost = uFloorFocus * smoothstep(5.0, 8.0, abs(aPos.z - uPlayerPos.z));
      // Туман: дальнее тонет в фоне — у сцены появляется глубина
      float fog = smoothstep(uFogFar * 0.35, uFogFar, w);
      vColor = mix(color, vec3(${BG[0]}, ${BG[1]}, ${BG[2]}), max(ghost * 0.88, fog * 0.85));
      // Лог-глубина: линейная упаковка 300 м в 8-битную альфу давала ~1 м на
      // шаг — стены в паре метров друг от друга становились неразличимы для EDL
      vDepth = clamp(log2(1.0 + w) / 8.24, 0.0, 1.0);
      // Два прохода (яркие пишут глубину, призраки нет): не наш — выбрасываем
      float g = step(0.5, ghost);
      vDrop = uGhostPass < -0.5 ? 0.0 : abs(g - uGhostPass);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform float uIsLine;
    varying vec3 vColor;
    varying float vDepth;
    varying float vDrop;
    void main() {
      if (vDrop > 0.5) discard;
      // Круглые точки: отбрасываем углы квадратного спрайта
      // (для линий gl_PointCoord не определён — не трогаем)
      if (uIsLine < 0.5) {
        vec2 fromCenter = gl_PointCoord - vec2(0.5);
        if (dot(fromCenter, fromCenter) > 0.25) discard;
      }
      // Глубина уходит в альфу оффскрин-текстуры — её читает EDL-проход
      gl_FragColor = vec4(vColor, vDepth);
    }
  `;

  // EDL (Eye-Dome Lighting): затемняем пиксель, если соседи ближе к камере, —
  // у облака появляются контуры и рельеф, как в Potree/CloudCompare
  const EDL_VERTEX = `
    attribute vec2 aQuad;
    varying vec2 vUv;
    void main() {
      vUv = aQuad * 0.5 + 0.5;
      gl_Position = vec4(aQuad, 0.0, 1.0);
    }
  `;

  const EDL_FRAGMENT = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec2 uInvSize;
    uniform float uStrength;
    varying vec2 vUv;
    float edlResp(vec2 offs, float zc) {
      return max(0.0, zc - texture2D(uTex, vUv + offs).a);
    }
    void main() {
      vec4 c = texture2D(uTex, vUv);
      float zc = c.a;
      vec2 px = uInvSize;
      // Сэмплы на 1px попадали внутрь собственного спрайта точки (до 6px) —
      // разница глубин была нулевой и затенение не работало. Кольцо 2px
      // выходит за спрайт, кольцо 4px ловит «стену за стеной» через прорехи
      // между точками ближней стены.
      float resp = 0.0;
      resp += edlResp(vec2( 2.0 * px.x, 0.0), zc);
      resp += edlResp(vec2(-2.0 * px.x, 0.0), zc);
      resp += edlResp(vec2(0.0,  2.0 * px.y), zc);
      resp += edlResp(vec2(0.0, -2.0 * px.y), zc);
      resp += edlResp(vec2( 4.0 * px.x,  4.0 * px.y), zc) * 0.6;
      resp += edlResp(vec2(-4.0 * px.x,  4.0 * px.y), zc) * 0.6;
      resp += edlResp(vec2( 4.0 * px.x, -4.0 * px.y), zc) * 0.6;
      resp += edlResp(vec2(-4.0 * px.x, -4.0 * px.y), zc) * 0.6;
      resp /= 6.4;
      // Пол яркости 0.2: дальняя стена заметно темнее, но не исчезает
      float shade = max(exp(-uStrength * resp), 0.2);
      gl_FragColor = vec4(c.rgb * shade, 1.0);
    }
  `;

  let canvas = null;
  let gl = null;
  let program = null;
  let attribs = {};
  let uniforms = {};

  // EDL: оффскрин-текстура сцены + фуллскрин-проход подсветки контуров
  let edlProgram = null;
  let edlUniforms = {};
  let edlQuadBuffer = null;
  let fbo = null;
  let fboTexture = null;
  let fboDepth = null;
  let fboWidth = 0, fboHeight = 0;
  let edlOk = false;         // фолбэк: если FBO не собрался — рендер напрямую

  let floorFocus = true;     // режим «этаж ярко, остальное призраком»

  let cloudBuffer = null;   // interleaved: x,y,z, r,g,b
  let cloudCount = 0;
  let playerBuffer = null;
  let playerCount = 0;
  let playerPos = null;     // [x, y, z] в метрах — для раскраски по расстоянию

  let waypointBuffer = null;
  let waypoints = [];       // [{x, y, z (м), name}] — для маркеров и подписей
  let routeBuffer = null;
  let routeCount = 0;

  let selectionBuffer = null;   // линия связи выбранного элемента (портал/тележка)
  let selectionCount = 0;

  let hudCanvas = null;     // 2D-оверлей для подписей
  let hudCtx = null;
  let lastMvp = null;
  let labelBoxes = [];      // клик-зоны подписей за последний кадр (как в 2D)
  let pickCallback = null;  // вызывается при клике по метке в 3D
  let lastInteract = 0;     // время последнего ввода — для авто-облёта в простое
  let autoOrbit = true;     // медленный облёт после простоя

  // Орбитальная камера вокруг цели (в метрах, оси UE)
  const camera = {
    target: [0, 0, 1],
    yaw: -Math.PI / 4,   // вокруг вертикали
    pitch: 0.5,          // наклон (0 — сбоку, pi/2 — сверху)
    dist: 30,
  };

  let active = false;
  let rafId = null;

  // ==================== Матрицы ====================

  function mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
        out[col * 4 + row] = sum;
      }
    }
    return out;
  }

  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function lookAt(eye, target, up) {
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    const x = [
      up[1] * z[2] - up[2] * z[1],
      up[2] * z[0] - up[0] * z[2],
      up[0] * z[1] - up[1] * z[0],
    ];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x[0] /= xl; x[1] /= xl; x[2] /= xl;
    const y = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0],
    ];
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ]);
  }

  function cameraEye() {
    const horizontal = Math.cos(camera.pitch) * camera.dist;
    return [
      camera.target[0] + Math.cos(camera.yaw) * horizontal,
      camera.target[1] + Math.sin(camera.yaw) * horizontal,
      camera.target[2] + Math.sin(camera.pitch) * camera.dist,
    ];
  }

  function mvpMatrix() {
    const proj = perspective(Math.PI / 3, canvas.width / canvas.height, 0.1, 2000);
    // Ось "вверх" — мировая Z (UE)
    const view = lookAt(cameraEye(), camera.target, [0, 0, 1]);
    return mat4Multiply(proj, view);
  }

  // ==================== Инициализация GL ====================

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error("Shader: " + gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  function init(canvasElement, hudElement) {
    canvas = canvasElement;
    gl = canvas.getContext("webgl", { antialias: false, preserveDrawingBuffer: true });
    if (!gl) return false;
    if (hudElement) {
      hudCanvas = hudElement;
      hudCtx = hudCanvas.getContext("2d");
    }

    program = gl.createProgram();
    gl.attachShader(program, compileShader(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error("Program: " + gl.getProgramInfoLog(program));
    }
    gl.useProgram(program);

    attribs.pos = gl.getAttribLocation(program, "aPos");
    attribs.color = gl.getAttribLocation(program, "aColor");
    uniforms.mvp = gl.getUniformLocation(program, "uMvp");
    uniforms.pointScale = gl.getUniformLocation(program, "uPointScale");
    uniforms.maxSize = gl.getUniformLocation(program, "uMaxSize");
    uniforms.playerPos = gl.getUniformLocation(program, "uPlayerPos");
    uniforms.useDistance = gl.getUniformLocation(program, "uUseDistance");
    uniforms.floorFocus = gl.getUniformLocation(program, "uFloorFocus");
    uniforms.fogFar = gl.getUniformLocation(program, "uFogFar");
    uniforms.ghostPass = gl.getUniformLocation(program, "uGhostPass");
    uniforms.isLine = gl.getUniformLocation(program, "uIsLine");

    cloudBuffer = gl.createBuffer();
    playerBuffer = gl.createBuffer();
    waypointBuffer = gl.createBuffer();
    routeBuffer = gl.createBuffer();
    selectionBuffer = gl.createBuffer();

    // EDL-программа + фуллскрин-квад
    try {
      edlProgram = gl.createProgram();
      gl.attachShader(edlProgram, compileShader(gl.VERTEX_SHADER, EDL_VERTEX));
      gl.attachShader(edlProgram, compileShader(gl.FRAGMENT_SHADER, EDL_FRAGMENT));
      gl.linkProgram(edlProgram);
      if (!gl.getProgramParameter(edlProgram, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(edlProgram));
      }
      edlUniforms.tex = gl.getUniformLocation(edlProgram, "uTex");
      edlUniforms.invSize = gl.getUniformLocation(edlProgram, "uInvSize");
      edlUniforms.strength = gl.getUniformLocation(edlProgram, "uStrength");
      edlUniforms.quad = gl.getAttribLocation(edlProgram, "aQuad");
      edlQuadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, edlQuadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // один треугольник на весь экран
      edlOk = true;
    } catch (err) {
      edlOk = false; // без EDL, но с туманом и этажами
    }

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(BG[0], BG[1], BG[2], 1.0);

    bindInput();
    return true;
  }

  // (Пере)создать оффскрин-буфер под размер канваса. Альфа текстуры хранит
  // линейную глубину для EDL, фон очищается альфой 1 (максимально далеко).
  function ensureFbo(width, height) {
    if (!edlOk) return false;
    if (fbo && fboWidth === width && fboHeight === height) return true;
    if (!fbo) {
      fbo = gl.createFramebuffer();
      fboTexture = gl.createTexture();
      fboDepth = gl.createRenderbuffer();
    }
    gl.bindTexture(gl.TEXTURE_2D, fboTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindRenderbuffer(gl.RENDERBUFFER, fboDepth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, fboDepth);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) { edlOk = false; return false; }
    fboWidth = width;
    fboHeight = height;
    return true;
  }

  // ==================== Данные ====================

  // UE — левосторонняя система координат, наша камера — правосторонняя:
  // без инверсии Y мир рендерится зеркально. Все входные точки идут через toGL.
  function toGL(x, y, z) {
    return [x / 100, -y / 100, z / 100];
  }

  // Цвет по высоте: тёплый пол → холодный потолок (относительно диапазона облака)
  function heightColor(zNorm) {
    const clamped = Math.min(1, Math.max(0, zNorm));
    return [
      0.55 + 0.35 * (1 - clamped),
      0.45 + 0.25 * clamped,
      0.35 + 0.6 * clamped,
    ];
  }

  function setCloud(cells) {
    const count = cells.length;
    const data = new Float32Array(count * 6);
    let minZ = Infinity, maxZ = -Infinity;
    for (const cell of cells) {
      const z = cell.gz;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const zSpan = Math.max(1, maxZ - minZ);
    let offset = 0;
    for (const cell of cells) {
      const scale = SCAN_CELL; // ячейки → см, дальше toGL
      const [px, py, pz] = toGL(cell.gx * scale, cell.gy * scale, cell.gz * scale);
      data[offset++] = px;
      data[offset++] = py;
      data[offset++] = pz;
      const [r, g, b] = heightColor((cell.gz - minZ) / zSpan);
      data[offset++] = r;
      data[offset++] = g;
      data[offset++] = b;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    cloudCount = count;
  }

  // Облако прямо из чанкового хранилища app.js (columns: "gx:gy" -> {gx,gy,zs}),
  // без промежуточного массива из миллионов объектов — на 1.7 млн точек это
  // экономит около секунды главного потока при каждой пересборке.
  function setCloudFromColumns(columns, cellCm) {
    let count = 0;
    let minGz = Infinity, maxGz = -Infinity;
    for (const col of columns.values()) {
      for (const gz of col.zs.keys()) {
        if (gz < minGz) minGz = gz;
        if (gz > maxGz) maxGz = gz;
        count++;
      }
    }
    const data = new Float32Array(count * 6);
    const zSpan = Math.max(1, maxGz - minGz);
    let offset = 0;
    const k = cellCm / 100; // ячейки → метры GL
    for (const col of columns.values()) {
      const px = col.gx * k;
      const py = -col.gy * k; // UE левосторонняя, как в toGL
      for (const gz of col.zs.keys()) {
        data[offset++] = px;
        data[offset++] = py;
        data[offset++] = gz * k;
        const [r, g, b] = heightColor((gz - minGz) / zSpan);
        data[offset++] = r;
        data[offset++] = g;
        data[offset++] = b;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, cloudBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    cloudCount = count;
  }

  // Вейпоинты: массив {x, y, z} в см мира + name
  function setWaypoints(list) {
    waypoints = list.map(w => {
      const [x, y, z] = toGL(w.x, w.y, w.z);
      return { x, y, z, name: w.name, type: w.type, id: w.id };
    });
    const data = new Float32Array(waypoints.length * 6);
    let offset = 0;
    for (const w of waypoints) {
      data[offset++] = w.x;
      data[offset++] = w.y;
      data[offset++] = w.z;
      data[offset++] = 1.0; data[offset++] = 0.35; data[offset++] = 0.85; // маджента
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, waypointBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  // Маршрут: массив точек {x, y, z} в см мира
  function setRoute(points) {
    routeCount = points.length;
    if (routeCount === 0) return;
    const data = new Float32Array(routeCount * 6);
    let offset = 0;
    for (const p of points) {
      const [px, py, pz] = toGL(p.x, p.y, p.z);
      data[offset++] = px;
      data[offset++] = py;
      data[offset++] = pz + 0.3; // чуть выше пола, чтобы не тонул в точках
      data[offset++] = 1.0; data[offset++] = 0.9; data[offset++] = 0.2; // жёлтый
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, routeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  // Линия связи выбранного элемента (портал вход->выход, путь тележки) в см мира
  function setSelectionLink(points) {
    selectionCount = points ? points.length : 0;
    if (selectionCount === 0) return;
    const data = new Float32Array(selectionCount * 6);
    let offset = 0;
    for (const p of points) {
      const [px, py, pz] = toGL(p.x, p.y, p.z);
      data[offset++] = px;
      data[offset++] = py;
      data[offset++] = pz + 0.4;
      data[offset++] = 0.9; data[offset++] = 0.72; data[offset++] = 0.1; // золотой
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, selectionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }

  function clearSelectionLink() {
    selectionCount = 0;
  }

  function setPlayers(players) {
    const data = new Float32Array(players.length * 6);
    let offset = 0;
    for (const player of players) {
      const [px, py, pz] = toGL(player.x, player.y, player.z);
      data[offset++] = px;
      data[offset++] = py;
      data[offset++] = pz;
      if (player.isLocal) {
        data[offset++] = 0.25; data[offset++] = 0.85; data[offset++] = 0.35;
      } else {
        data[offset++] = 0.35; data[offset++] = 0.65; data[offset++] = 1.0;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, playerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    playerCount = players.length;
  }

  function drawBuffer(buffer, count, pointScale, maxSize, useDistance, opts) {
    if (count === 0) return;
    const o = opts || {};
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attribs.pos);
    gl.enableVertexAttribArray(attribs.color);
    gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(attribs.color, 3, gl.FLOAT, false, 24, 12);
    gl.uniform1f(uniforms.pointScale, pointScale);
    gl.uniform1f(uniforms.maxSize, maxSize);
    gl.uniform1f(uniforms.useDistance, useDistance);
    gl.uniform1f(uniforms.floorFocus, o.floorFocus || 0.0);
    gl.uniform1f(uniforms.ghostPass, o.ghostPass !== undefined ? o.ghostPass : -1.0);
    gl.uniform1f(uniforms.isLine, o.isLine ? 1.0 : 0.0);
    gl.drawArrays(o.isLine ? gl.LINE_STRIP : gl.POINTS, 0, count);
  }

  function render() {
    if (!active) return;
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      // Окно свёрнуто/нулевого размера — ждём следующий кадр
      rafId = requestAnimationFrame(render);
      return;
    }
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
    }

    // Авто-облёт: после 15 с без ввода камера медленно вращается вокруг цели
    // (это игрок, если включён Follow) — даёт параллакс для восприятия глубины
    if (autoOrbit && performance.now() - lastInteract > 15000) {
      camera.yaw -= 0.0016; // ~5.5°/с при 60 fps
    }

    // Сцена рисуется в оффскрин-текстуру (глубина в альфе), затем EDL-проход
    // кладёт её на экран с подсветкой контуров. Без FBO — напрямую.
    const useEdl = ensureFbo(canvas.width, canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, useEdl ? fbo : null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.clearColor(BG[0], BG[1], BG[2], 1.0); // альфа 1 = «далеко» для EDL
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    lastMvp = mvpMatrix();
    gl.uniformMatrix4fv(uniforms.mvp, false, lastMvp);
    gl.uniform3fv(uniforms.playerPos, playerPos || [0, 0, 0]);
    // Туман масштабируется с зумом: вблизи — локальная структура,
    // издалека — целые сектора
    gl.uniform1f(uniforms.fogFar, Math.max(60, camera.dist * 3.0));

    // Режим этажа активен только когда знаем высоту игрока
    const focus = (floorFocus && playerPos) ? 1.0 : 0.0;
    const useDist = playerPos ? 1.0 : 0.0;
    if (focus > 0) {
      // Призраки без записи глубины — не заслоняют яркий этаж,
      // потом яркие поверх с обычным depth-тестом
      gl.depthMask(false);
      drawBuffer(cloudBuffer, cloudCount, canvas.height * 0.28, 6.0, 0.0,
                 { floorFocus: 1.0, ghostPass: 1.0 });
      gl.depthMask(true);
      drawBuffer(cloudBuffer, cloudCount, canvas.height * 0.28, 6.0, useDist,
                 { floorFocus: 1.0, ghostPass: 0.0 });
    } else {
      // Без позиции игрока откатываемся на цвет из буфера (по высоте)
      drawBuffer(cloudBuffer, cloudCount, canvas.height * 0.28, 6.0, useDist);
    }
    if (routeCount > 0) {
      drawBuffer(routeBuffer, routeCount, canvas.height * 1.2, 5.0, 0.0);
      drawBuffer(routeBuffer, routeCount, canvas.height * 1.2, 5.0, 0.0, { isLine: true });
    }
    if (selectionCount > 0) {
      drawBuffer(selectionBuffer, selectionCount, canvas.height * 2.0, 10.0, 0.0);
      drawBuffer(selectionBuffer, selectionCount, canvas.height * 2.0, 10.0, 0.0, { isLine: true });
    }
    drawBuffer(waypointBuffer, waypoints.length, canvas.height * 4.0, 16.0, 0.0);
    drawBuffer(playerBuffer, playerCount, canvas.height * 3.0, 14.0, 0.0);

    if (useEdl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.DEPTH_TEST);
      gl.useProgram(edlProgram);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboTexture);
      gl.uniform1i(edlUniforms.tex, 0);
      gl.uniform2f(edlUniforms.invSize, 1 / canvas.width, 1 / canvas.height);
      gl.uniform1f(edlUniforms.strength, 12.0);
      gl.bindBuffer(gl.ARRAY_BUFFER, edlQuadBuffer);
      gl.enableVertexAttribArray(edlUniforms.quad);
      gl.vertexAttribPointer(edlUniforms.quad, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disableVertexAttribArray(edlUniforms.quad);
      gl.enable(gl.DEPTH_TEST);
    }

    drawLabels();
    rafId = requestAnimationFrame(render);
  }

  // Проекция мировой точки (в метрах) на экран через последнюю MVP-матрицу
  function project(x, y, z) {
    const m = lastMvp;
    if (!m) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.1) return null; // за камерой
    return {
      x: (cx / cw + 1) / 2 * canvas.width,
      y: (1 - cy / cw) / 2 * canvas.height,
    };
  }

  function drawLabels() {
    if (!hudCtx) return;
    if (hudCanvas.width !== canvas.width || hudCanvas.height !== canvas.height) {
      hudCanvas.width = canvas.width;
      hudCanvas.height = canvas.height;
    }
    hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    hudCtx.font = "13px 'Segoe UI', sans-serif";
    hudCtx.textAlign = "center";
    labelBoxes = [];
    for (const w of waypoints) {
      const p = project(w.x, w.y, w.z);
      if (!p) continue;
      const label = playerPos
        ? t("hud_distance", { name: w.name,
            dist: Math.hypot(w.x - playerPos[0], w.y - playerPos[1], w.z - playerPos[2]).toFixed(0) })
        : w.name;
      hudCtx.fillStyle = "rgba(13, 17, 23, 0.75)";
      const width = hudCtx.measureText(label).width + 10;
      hudCtx.fillRect(p.x - width / 2, p.y - 34, width, 20);
      hudCtx.fillStyle = "#ff59d9";
      hudCtx.fillText(label, p.x, p.y - 20);
      // Клик-зона: и по подписи, и по маркеру-точке (радиус у p)
      if (w.type && w.id !== undefined) {
        labelBoxes.push({
          type: w.type, id: w.id,
          x0: p.x - width / 2, x1: p.x + width / 2, y0: p.y - 34, y1: p.y - 14,
          px: p.x, py: p.y,
        });
      }
    }
  }

  // Что под кликом (px канваса): подпись или маркер. {type, id} или null.
  function pickMarker(sx, sy) {
    // Подписи — первыми (нарисованные позже лежат сверху), с конца
    for (let i = labelBoxes.length - 1; i >= 0; i--) {
      const b = labelBoxes[i];
      if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) {
        return { type: b.type, id: b.id };
      }
    }
    // Иначе — ближайшая точка-маркер в радиусе
    let best = null, bestDist = 16;
    for (const b of labelBoxes) {
      const d = Math.hypot(sx - b.px, sy - b.py);
      if (d <= bestDist) { bestDist = d; best = { type: b.type, id: b.id }; }
    }
    return best;
  }

  // ==================== Управление ====================

  function poke() { lastInteract = performance.now(); }

  function eventXY(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function bindInput() {
    let dragging = null; // {mode: "orbit"|"pan", x, y}
    let downAt = null;   // позиция mousedown — отличить клик от вращения

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("mousedown", (e) => {
      const mode = (e.button === 2 || e.shiftKey) ? "pan" : "orbit";
      dragging = { mode, x: e.clientX, y: e.clientY, moved: false };
      downAt = { x: e.clientX, y: e.clientY, button: e.button };
      poke();
    });

    window.addEventListener("mouseup", (e) => {
      // Клик без вращения по левой кнопке = выбор метки
      if (downAt && downAt.button === 0 && active && pickCallback &&
          Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) {
        const p = eventXY(e);
        const hit = pickMarker(p.x, p.y);
        if (hit) pickCallback(hit);
      }
      dragging = null;
      downAt = null;
    });

    window.addEventListener("mousemove", (e) => {
      // Курсор-указатель над кликабельной меткой (когда не вращаем)
      if (active && !dragging && pickCallback) {
        const p = eventXY(e);
        canvas.style.cursor = pickMarker(p.x, p.y) ? "pointer" : "";
      }
      if (!dragging || !active) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      poke();
      if (dragging.mode === "orbit") {
        camera.yaw -= dx * 0.006;
        camera.pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, camera.pitch + dy * 0.006));
      } else {
        // Панорама в горизонтальной плоскости относительно направления камеры
        const speed = camera.dist * 0.0015;
        const sin = Math.sin(camera.yaw), cos = Math.cos(camera.yaw);
        camera.target[0] += (dx * sin - dy * cos) * speed;
        camera.target[1] += (-dx * cos - dy * sin) * speed;
      }
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      poke();
      camera.dist = Math.min(500, Math.max(2, camera.dist * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });

    // Тач: один палец — вращение, два — щипок (зум) и сдвиг (панорама)
    let touch = null;

    let tapStart = null; // для распознавания тапа по метке на телефоне

    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      poke();
      if (e.touches.length === 1) {
        touch = { mode: "orbit", x: e.touches[0].clientX, y: e.touches[0].clientY };
        tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        tapStart = null;
        const [a, b] = e.touches;
        touch = {
          mode: "pinch",
          dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
          mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
        };
      }
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      e.preventDefault();
      poke();
      if (!touch || !active) return;
      if (touch.mode === "orbit" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - touch.x;
        const dy = e.touches[0].clientY - touch.y;
        if (tapStart && Math.hypot(e.touches[0].clientX - tapStart.x, e.touches[0].clientY - tapStart.y) > 8) {
          tapStart = null; // палец поехал — это вращение, не тап
        }
        touch.x = e.touches[0].clientX;
        touch.y = e.touches[0].clientY;
        camera.yaw -= dx * 0.008;
        camera.pitch = Math.min(Math.PI / 2 - 0.01, Math.max(-Math.PI / 2 + 0.01, camera.pitch + dy * 0.008));
      } else if (touch.mode === "pinch" && e.touches.length === 2) {
        const [a, b] = e.touches;
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
        camera.dist = Math.min(500, Math.max(2, camera.dist * touch.dist / dist));
        const speed = camera.dist * 0.0022;
        const dx = mid.x - touch.mid.x;
        const dy = mid.y - touch.mid.y;
        const sin = Math.sin(camera.yaw), cos = Math.cos(camera.yaw);
        camera.target[0] += (dx * sin - dy * cos) * speed;
        camera.target[1] += (-dx * cos - dy * sin) * speed;
        touch.dist = dist;
        touch.mid = mid;
      }
    }, { passive: false });

    canvas.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) {
        touch = null;
        if (tapStart && active && pickCallback) {
          const rect = canvas.getBoundingClientRect();
          const hit = pickMarker(tapStart.x - rect.left, tapStart.y - rect.top);
          if (hit) pickCallback(hit);
        }
        tapStart = null;
      }
    }, { passive: false });
  }

  // ==================== Публичный API ====================

  return {
    init,
    setCloud,
    setCloudFromColumns,
    setFloorFocus(on) { floorFocus = !!on; },
    setPlayers,
    setWaypoints,
    setRoute,
    clearRoute() { routeCount = 0; },
    setSelectionLink,
    clearSelectionLink,
    pickMarker,
    onMarkerClick(fn) { pickCallback = fn; },
    setAutoOrbit(on) { autoOrbit = !!on; },
    centerOn(x, y, z) {
      camera.target = toGL(x, y, z);
    },
    setPlayerPos(x, y, z) {
      playerPos = toGL(x, y, z);
    },
    start() {
      active = true;
      poke(); // отсчёт простоя с момента открытия 3D
      render();
    },
    stop() {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (hudCtx) hudCtx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
    },
    get pointCount() { return cloudCount; },
  };
})();
