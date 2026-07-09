// AF LiveMap — 3D-вид облака точек на чистом WebGL (без библиотек).
// Мировые оси UE: X/Y — горизонталь, Z — вверх. Координаты в метрах (см / 100).
// Камера орбитальная: ЛКМ — вращение, колесо — приближение, ПКМ/Shift+ЛКМ — панорама.

"use strict";

const View3D = (() => {
  const VERTEX_SHADER = `
    attribute vec3 aPos;
    attribute vec3 aColor;
    uniform mat4 uMvp;
    uniform float uPointScale;
    uniform float uMaxSize;
    uniform vec3 uPlayerPos;
    uniform float uUseDistance;
    varying vec3 vColor;
    void main() {
      gl_Position = uMvp * vec4(aPos, 1.0);
      float size = uPointScale / max(gl_Position.w, 0.1);
      gl_PointSize = clamp(size, 1.0, uMaxSize);
      // Цвет по расстоянию от игрока: тёплое близко -> зелёное -> синее далеко.
      // Считается в шейдере, поэтому перекрашивается на лету при движении.
      float d = distance(aPos, uPlayerPos);
      float t = clamp(d / 40.0, 0.0, 1.0);
      vec3 cNear = vec3(1.0, 0.62, 0.25);
      vec3 cMid  = vec3(0.45, 0.85, 0.5);
      vec3 cFar  = vec3(0.4, 0.5, 1.0);
      vec3 distColor = t < 0.5 ? mix(cNear, cMid, t * 2.0) : mix(cMid, cFar, t * 2.0 - 1.0);
      vColor = mix(aColor, distColor, uUseDistance);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      // Круглые точки: отбрасываем углы квадратного спрайта
      vec2 fromCenter = gl_PointCoord - vec2(0.5);
      if (dot(fromCenter, fromCenter) > 0.25) discard;
      gl_FragColor = vec4(vColor, 1.0);
    }
  `;

  let canvas = null;
  let gl = null;
  let program = null;
  let attribs = {};
  let uniforms = {};

  let cloudBuffer = null;   // interleaved: x,y,z, r,g,b
  let cloudCount = 0;
  let playerBuffer = null;
  let playerCount = 0;
  let playerPos = null;     // [x, y, z] в метрах — для раскраски по расстоянию

  let waypointBuffer = null;
  let waypoints = [];       // [{x, y, z (м), name}] — для маркеров и подписей
  let routeBuffer = null;
  let routeCount = 0;

  let hudCanvas = null;     // 2D-оверлей для подписей
  let hudCtx = null;
  let lastMvp = null;

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

    cloudBuffer = gl.createBuffer();
    playerBuffer = gl.createBuffer();
    waypointBuffer = gl.createBuffer();
    routeBuffer = gl.createBuffer();

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.05, 0.07, 0.09, 1.0);

    bindInput();
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

  // Вейпоинты: массив {x, y, z} в см мира + name
  function setWaypoints(list) {
    waypoints = list.map(w => {
      const [x, y, z] = toGL(w.x, w.y, w.z);
      return { x, y, z, name: w.name };
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

  function drawBuffer(buffer, count, pointScale, maxSize, useDistance) {
    if (count === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attribs.pos);
    gl.enableVertexAttribArray(attribs.color);
    gl.vertexAttribPointer(attribs.pos, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(attribs.color, 3, gl.FLOAT, false, 24, 12);
    gl.uniform1f(uniforms.pointScale, pointScale);
    gl.uniform1f(uniforms.maxSize, maxSize);
    gl.uniform1f(uniforms.useDistance, useDistance);
    gl.drawArrays(gl.POINTS, 0, count);
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
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    lastMvp = mvpMatrix();
    gl.uniformMatrix4fv(uniforms.mvp, false, lastMvp);
    gl.uniform3fv(uniforms.playerPos, playerPos || [0, 0, 0]);
    // Без позиции игрока откатываемся на цвет из буфера (по высоте)
    drawBuffer(cloudBuffer, cloudCount, canvas.height * 0.28, 6.0, playerPos ? 1.0 : 0.0);
    if (routeCount > 0) {
      drawBuffer(routeBuffer, routeCount, canvas.height * 1.2, 5.0, 0.0);
      gl.drawArrays(gl.LINE_STRIP, 0, routeCount);
    }
    drawBuffer(waypointBuffer, waypoints.length, canvas.height * 4.0, 16.0, 0.0);
    drawBuffer(playerBuffer, playerCount, canvas.height * 3.0, 14.0, 0.0);
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
    for (const w of waypoints) {
      const p = project(w.x, w.y, w.z);
      if (!p) continue;
      const label = playerPos
        ? `${w.name} (${Math.hypot(w.x - playerPos[0], w.y - playerPos[1], w.z - playerPos[2]).toFixed(0)} м)`
        : w.name;
      hudCtx.fillStyle = "rgba(13, 17, 23, 0.75)";
      const width = hudCtx.measureText(label).width + 10;
      hudCtx.fillRect(p.x - width / 2, p.y - 34, width, 20);
      hudCtx.fillStyle = "#ff59d9";
      hudCtx.fillText(label, p.x, p.y - 20);
    }
  }

  // ==================== Управление ====================

  function bindInput() {
    let dragging = null; // {mode: "orbit"|"pan", x, y}

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("mousedown", (e) => {
      const mode = (e.button === 2 || e.shiftKey) ? "pan" : "orbit";
      dragging = { mode, x: e.clientX, y: e.clientY };
    });

    window.addEventListener("mouseup", () => { dragging = null; });

    window.addEventListener("mousemove", (e) => {
      if (!dragging || !active) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.x = e.clientX;
      dragging.y = e.clientY;
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
      camera.dist = Math.min(500, Math.max(2, camera.dist * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
    }, { passive: false });

    // Тач: один палец — вращение, два — щипок (зум) и сдвиг (панорама)
    let touch = null;

    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        touch = { mode: "orbit", x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
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
      if (!touch || !active) return;
      if (touch.mode === "orbit" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - touch.x;
        const dy = e.touches[0].clientY - touch.y;
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
      if (e.touches.length === 0) touch = null;
    }, { passive: false });
  }

  // ==================== Публичный API ====================

  return {
    init,
    setCloud,
    setPlayers,
    setWaypoints,
    setRoute,
    clearRoute() { routeCount = 0; },
    centerOn(x, y, z) {
      camera.target = toGL(x, y, z);
    },
    setPlayerPos(x, y, z) {
      playerPos = toGL(x, y, z);
    },
    start() {
      active = true;
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
