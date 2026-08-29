"use strict";

// ---------------------------------------------------------------------------
// Shared full-site sign-in gate, used identically by the portal and every
// event app (copied verbatim into each directory -- same convention as
// icons.js/styles.css, see gamescom2026/app.js's own note on why this
// codebase duplicates small shared files instead of adding a build step).
//
// The site is gated behind sign-up now: every backend route that returns
// real app data requires a session (see main.py's Depends(auth.require_user)
// and auth.py's require_user), so this isn't just a UI speed bump -- an
// unauthenticated fetch to /loot, /giveaways, /leaderboard, /event-catalog,
// or the SSE stream genuinely 401s. This file is the client side of that:
// call `ensureAuthGate()` before an app's own init() does anything else.
// If already signed in it resolves true immediately and does nothing
// visible. Otherwise it shows a full-screen gate (WebGL sparkle background
// + Google/GitHub + email sign-up/login) and resolves false -- the caller
// should just return, since a successful sign-in reloads the page and lets
// that app's own init() run again from the top with a valid session.
// ---------------------------------------------------------------------------

(function () {
  const API_BASE = "/api";

  function deviceId() {
    let id = localStorage.getItem("lr_device_id");
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/-/g, "");
      localStorage.setItem("lr_device_id", id);
    }
    return id;
  }

  // -------------------------------------------------------------------------
  // WebGL sparkle background -- rising gold/silver/bronze/brand-colored
  // points with a twinkle and slight mouse parallax. Hand-written WebGL1,
  // no library (matching this app's zero-dependency policy) -- purely
  // procedural points, no textures/assets to load. Fails soft: if WebGL
  // isn't available, the gate still renders and works fine, just without
  // the animated background.
  // -------------------------------------------------------------------------

  function startSparkles(canvas) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: true }) || canvas.getContext("experimental-webgl");
    if (!gl) return { stop() {} };

    const VERT = `
      attribute vec2 aBase;
      attribute float aSeed;
      attribute vec3 aColor;
      uniform float uTime;
      uniform vec2 uMouse;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        float speed = 0.015 + aSeed * 0.03;
        float y = fract(aBase.y + uTime * speed);
        float sway = sin(uTime * (0.4 + aSeed * 0.6) + aSeed * 12.0) * 0.035;
        float x = fract(aBase.x + sway + uMouse.x * 0.03 * (aSeed - 0.5) + 1.0);
        vec2 pos = vec2(x, y) * 2.0 - 1.0;
        gl_Position = vec4(pos.x, pos.y, 0.0, 1.0);
        vTwinkle = 0.5 + 0.5 * sin(uTime * (1.2 + aSeed * 2.5) + aSeed * 30.0);
        gl_PointSize = (1.3 + aSeed * 3.4) * (0.55 + vTwinkle * 0.9);
        vColor = aColor;
      }
    `;
    const FRAG = `
      precision mediump float;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * (0.22 + vTwinkle * 0.55);
        gl_FragColor = vec4(vColor * (0.8 + vTwinkle * 0.4), alpha);
      }
    `;

    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return { stop() {} };
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return { stop() {} };
    gl.useProgram(program);

    // Loot-rank colors (gold/silver/bronze) plus the app's own brand blue
    // and success green -- the same palette the map/leaderboard already
    // use for rank tiers, so the sparkle field reads as "loot" rather than
    // generic stock particles.
    const COLORS = [
      [0.910, 0.702, 0.290],
      [0.718, 0.749, 0.788],
      [0.792, 0.541, 0.362],
      [0.310, 0.486, 1.0],
      [0.208, 0.788, 0.549],
    ];
    const COUNT = 170;
    const base = new Float32Array(COUNT * 2);
    const seed = new Float32Array(COUNT);
    const color = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      base[i * 2] = Math.random();
      base[i * 2 + 1] = Math.random();
      seed[i] = Math.random();
      const c = COLORS[i % COLORS.length];
      color[i * 3] = c[0]; color[i * 3 + 1] = c[1]; color[i * 3 + 2] = c[2];
    }

    function bindAttr(data, size, name) {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    bindAttr(base, 2, "aBase");
    bindAttr(seed, 1, "aSeed");
    bindAttr(color, 3, "aColor");

    const uTime = gl.getUniformLocation(program, "uTime");
    const uMouse = gl.getUniformLocation(program, "uMouse");

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(0.039, 0.043, 0.051, 1.0); // matches --bg #0a0b0d

    let mouse = [0, 0];
    let running = true;
    let raf = null;
    const startedAt = performance.now();

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    resize();
    window.addEventListener("resize", resize);

    function onMove(e) {
      const t = e.touches ? e.touches[0] : e;
      if (!t) return;
      mouse[0] = (t.clientX / window.innerWidth) * 2 - 1;
      mouse[1] = (t.clientY / window.innerHeight) * 2 - 1;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onMove, { passive: true });

    function frame(now) {
      if (!running) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, (now - startedAt) / 1000);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.drawArrays(gl.POINTS, 0, COUNT);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return {
      stop() {
        running = false;
        if (raf) cancelAnimationFrame(raf);
        window.removeEventListener("resize", resize);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("touchmove", onMove);
      },
    };
  }

  // -------------------------------------------------------------------------
  // Gate DOM + email/OAuth wiring
  // -------------------------------------------------------------------------

  let mode = "signup"; // "signup" | "login"

  function buildGateDom() {
    const wrap = document.createElement("div");
    wrap.id = "auth-gate";
    wrap.innerHTML = `
      <canvas id="auth-gate-canvas"></canvas>
      <div class="auth-gate-card">
        <div class="auth-gate-brand"><span class="dot"></span>LOOTEMALL</div>
        <h1 class="auth-gate-title">Track the loot. Live.</h1>
        <p class="auth-gate-sub">Sign up to see the map, report finds, and catch scheduled giveaways as they happen.</p>

        <div id="auth-gate-oauth"></div>
        <div class="auth-gate-divider"><span>or</span></div>

        <form id="auth-gate-form" novalidate>
          <div class="field" id="auth-gate-name-field" style="display:none">
            <input type="text" id="auth-gate-name" placeholder="Display name (optional)" maxlength="60" autocomplete="nickname" />
          </div>
          <div class="field">
            <input type="email" id="auth-gate-email" placeholder="Email" autocomplete="email" required />
          </div>
          <div class="field">
            <input type="password" id="auth-gate-password" placeholder="Password" autocomplete="current-password" minlength="8" required />
          </div>
          <div class="auth-gate-error" id="auth-gate-error"></div>
          <button type="submit" class="btn btn-primary" id="auth-gate-submit" style="width:100%">Sign up</button>
        </form>
        <button type="button" class="auth-gate-toggle" id="auth-gate-toggle">Already have an account? Log in</button>
      </div>
    `;
    document.body.appendChild(wrap);
    return wrap;
  }

  async function loadOauthButtons(container) {
    try {
      const providers = await (await fetch(`${API_BASE}/auth/providers`)).json();
      let html = "";
      if (providers.google) html += `<button type="button" class="oauth-btn" id="auth-gate-google">${icon("google")}Continue with Google</button>`;
      if (providers.github) html += `<button type="button" class="oauth-btn" id="auth-gate-github">${icon("github")}Continue with GitHub</button>`;
      container.innerHTML = html;
      const g = document.getElementById("auth-gate-google");
      if (g) g.addEventListener("click", () => signInWithOAuth("google"));
      const h = document.getElementById("auth-gate-github");
      if (h) h.addEventListener("click", () => signInWithOAuth("github"));
    } catch (e) {
      container.innerHTML = "";
    }
  }

  function signInWithOAuth(provider) {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `${API_BASE}/auth/${provider}/login?device_id=${encodeURIComponent(deviceId())}&return_to=${encodeURIComponent(returnTo)}`;
  }

  function setMode(newMode) {
    mode = newMode;
    document.getElementById("auth-gate-name-field").style.display = mode === "signup" ? "" : "none";
    document.getElementById("auth-gate-password").setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
    document.getElementById("auth-gate-submit").textContent = mode === "signup" ? "Sign up" : "Log in";
    document.getElementById("auth-gate-toggle").textContent = mode === "signup" ? "Already have an account? Log in" : "New here? Sign up";
    document.getElementById("auth-gate-error").textContent = "";
  }

  async function submitForm(e) {
    e.preventDefault();
    const email = document.getElementById("auth-gate-email").value.trim();
    const password = document.getElementById("auth-gate-password").value;
    const name = document.getElementById("auth-gate-name").value.trim();
    const errEl = document.getElementById("auth-gate-error");
    const btn = document.getElementById("auth-gate-submit");
    errEl.textContent = "";
    if (mode === "signup" && password.length < 8) {
      errEl.textContent = "Password needs at least 8 characters";
      return;
    }
    btn.disabled = true;
    const prevText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      const path = mode === "signup" ? "/auth/email/signup" : "/auth/email/login";
      const body = mode === "signup"
        ? { email, password, display_name: name || undefined, device_id: deviceId() }
        : { email, password, device_id: deviceId() };
      const res = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error((detail.detail && String(detail.detail)) || "Something went wrong -- try again");
      }
      window.location.reload();
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }

  async function showAuthGate() {
    buildGateDom();
    loadOauthButtons(document.getElementById("auth-gate-oauth"));
    document.getElementById("auth-gate-form").addEventListener("submit", submitForm);
    document.getElementById("auth-gate-toggle").addEventListener("click", () => setMode(mode === "signup" ? "login" : "signup"));
    setMode("signup");
    startSparkles(document.getElementById("auth-gate-canvas"));
  }

  window.ensureAuthGate = async function ensureAuthGate() {
    let signedIn = false;
    try {
      const res = await fetch(`${API_BASE}/auth/me`);
      const data = await res.json();
      signedIn = !!(data && data.user);
    } catch (e) {
      signedIn = false;
    }
    if (signedIn) return true;
    await showAuthGate();
    return false;
  };
})();
