const $ = (id) => document.getElementById(id);

const canvas = $("game");
const ctx = canvas.getContext("2d");

const menu = $("menu");
const playBtn = $("playBtn");
const twitchBtn = $("twitchBtn");
const authStatus = $("authStatus");

const pseudoLabel = $("pseudoLabel");
const avatarImg = $("avatar");
const xpFill = $("xpFill");
const xpText = $("xpText");
const levelLabel = $("levelLabel");

const TWITCH_CLIENT_ID = "qjt85uubxukx6b0woq20r63sfermgz";
const TWITCH_REDIRECT_URI = `${window.location.origin}${window.location.pathname}`;
const TWITCH_STATE_KEY = "stellumin_twitch_state";
const TWITCH_CODE_VERIFIER_KEY = "stellumin_twitch_code_verifier";
const TWITCH_STORAGE_KEYS = {
  id: "stellumin_twitch_id",
  login: "stellumin_twitch_login",
  avatar: "stellumin_twitch_avatar"
};

let ws = null;
let myId = null;

let state = {
  players: [],
  foods: [],
  world: { w: 4000, h: 4000 }
};

let myLocal = {
  name: "Player",
  avatar: "",
  twitchId: "",
  xp: 0,
  level: 1
};

const WARNING_MARGIN = 300;
const backgroundStars = Array.from({ length: 260 }, () => ({
  x: Math.random() * 7000 - 3500,
  y: Math.random() * 7000 - 3500,
  r: Math.random() * 1.7 + 0.4,
  glow: Math.random() * 0.55 + 0.2,
  drift: Math.random() * 0.35 + 0.65
}));


function getServerUrl() {
  const fromConfig = window.STELLUMIN_CONFIG?.WS_SERVER_URL;
  if (fromConfig) return fromConfig;

  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1";
  if (isLocal) return "ws://localhost:8080";

  return "wss://stellumin-server.fly.dev";
}

function randomState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomCodeVerifier() {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

async function createCodeChallenge(verifier) {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return toBase64Url(new Uint8Array(digest));
}

function updateAuthStatus(profile) {
  if (!profile) {
    authStatus.textContent = "Non connecté à Twitch.";
    playBtn.disabled = true;
    return;
  }

  authStatus.textContent = `Connecté en tant que ${profile.login} (ID: ${profile.id})`;
  playBtn.disabled = false;
}

function getSavedTwitchProfile() {
  const id = localStorage.getItem(TWITCH_STORAGE_KEYS.id) || "";
  const login = localStorage.getItem(TWITCH_STORAGE_KEYS.login) || "";
  const avatar = localStorage.getItem(TWITCH_STORAGE_KEYS.avatar) || "";

  if (!id || !login) return null;
  return { id, login, avatar };
}

function saveTwitchProfile(profile) {
  localStorage.setItem(TWITCH_STORAGE_KEYS.id, profile.id);
  localStorage.setItem(TWITCH_STORAGE_KEYS.login, profile.login);
  localStorage.setItem(TWITCH_STORAGE_KEYS.avatar, profile.avatar || "");
}

async function fetchTwitchUser(accessToken) {
  const response = await fetch("https://api.twitch.tv/helix/users", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": TWITCH_CLIENT_ID
    }
  });

  if (!response.ok) {
    throw new Error(`Impossible de récupérer le profil Twitch (${response.status}).`);
  }

  const json = await response.json();
  const user = json?.data?.[0];
  if (!user) {
    throw new Error("Profil Twitch introuvable.");
  }

  return {
    id: user.id,
    login: user.display_name || user.login,
    avatar: user.profile_image_url || ""
  };
}

async function exchangeCodeForToken(code, verifier) {
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      grant_type: "authorization_code",
      code,
      redirect_uri: TWITCH_REDIRECT_URI,
      code_verifier: verifier
    })
  });

  if (!response.ok) {
    throw new Error(`Échange du code Twitch impossible (${response.status}).`);
  }

  const json = await response.json();
  if (!json.access_token) {
    throw new Error("Aucun access_token reçu de Twitch.");
  }

  return json.access_token;
}

async function maybeHandleTwitchRedirect() {
  const queryParams = new URLSearchParams(window.location.search);
  const hashParams = window.location.hash.startsWith("#")
    ? new URLSearchParams(window.location.hash.slice(1))
    : new URLSearchParams();
  const expectedState = sessionStorage.getItem(TWITCH_STATE_KEY);
  const queryError = queryParams.get("error") || hashParams.get("error");

  if (queryError) {
    const reason = queryParams.get("error_description") || hashParams.get("error_description") || queryError;
    authStatus.textContent = `Connexion Twitch refusée: ${decodeURIComponent(reason)}.`;
    sessionStorage.removeItem(TWITCH_STATE_KEY);
    sessionStorage.removeItem(TWITCH_CODE_VERIFIER_KEY);
    window.history.replaceState({}, document.title, TWITCH_REDIRECT_URI);
    return;
  }

  const code = queryParams.get("code");
  const token = hashParams.get("access_token");
  const stateValue = queryParams.get("state") || hashParams.get("state");

  if (!code && !token) return;

  sessionStorage.removeItem(TWITCH_STATE_KEY);

  if (!expectedState || stateValue !== expectedState) {
    authStatus.textContent = "Connexion Twitch invalide (state mismatch).";
    sessionStorage.removeItem(TWITCH_CODE_VERIFIER_KEY);
    window.history.replaceState({}, document.title, TWITCH_REDIRECT_URI);
    return;
  }

  try {
    authStatus.textContent = "Récupération du profil Twitch...";
    let accessToken = token;

    if (code) {
      const verifier = sessionStorage.getItem(TWITCH_CODE_VERIFIER_KEY) || "";
      sessionStorage.removeItem(TWITCH_CODE_VERIFIER_KEY);
      if (!verifier) {
        throw new Error("Code verifier Twitch manquant.");
      }
      accessToken = await exchangeCodeForToken(code, verifier);
    }

    if (!accessToken) {
      throw new Error("Aucun access token Twitch reçu.");
    }

    const profile = await fetchTwitchUser(accessToken);
    saveTwitchProfile(profile);
    updateAuthStatus(profile);
  } catch (err) {
    console.error(err);
    authStatus.textContent = "Erreur Twitch: impossible de charger le profil.";
  } finally {
    window.history.replaceState({}, document.title, TWITCH_REDIRECT_URI);
  }
}

async function startTwitchAuth() {
  const stateValue = randomState();
  const verifier = randomCodeVerifier();
  const challenge = await createCodeChallenge(verifier);
  sessionStorage.setItem(TWITCH_STATE_KEY, stateValue);
  sessionStorage.setItem(TWITCH_CODE_VERIFIER_KEY, verifier);

  const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authUrl.searchParams.set("client_id", TWITCH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", stateValue);

  window.location.href = authUrl.toString();
}

// XP / niveaux : simple et réglable
function xpForLevel(level) {
  // à ajuster plus tard)
  return 50 + (level - 1) * 25;
}
function computeLevelFromXp(xp) {
  let lvl = 1;
  let remaining = xp;
  while (remaining >= xpForLevel(lvl)) {
    remaining -= xpForLevel(lvl);
    lvl++;
  }
  return { lvl, inLevelXp: remaining, next: xpForLevel(lvl) };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function setHud(name, avatarUrl, xp) {
  pseudoLabel.textContent = name || "—";
  avatarImg.src = avatarUrl || "data:image/svg+xml;utf8," + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
      <rect width="100%" height="100%" fill="#111827"/>
      <circle cx="48" cy="42" r="18" fill="#93c5fd"/>
      <rect x="22" y="64" width="52" height="18" rx="9" fill="#1f2937"/>
    </svg>
  `);

  const { lvl, inLevelXp, next } = computeLevelFromXp(xp);
  levelLabel.textContent = String(lvl);
  xpText.textContent = `XP: ${inLevelXp} / ${next}`;
  xpFill.style.width = `${Math.floor((inLevelXp / next) * 100)}%`;
}

function connect(serverUrl, name, avatar, twitchId) {
  ws = new WebSocket(serverUrl);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join", name, avatar, twitchId }));
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "joined") {
      myId = msg.id;
      return;
    }

    if (msg.type === "state") {
      state.players = msg.players;
      state.foods = msg.foods;
      state.world = msg.world;

      const me = state.players.find(p => p.id === myId);
      if (me) {
        myLocal.xp = me.xp;
        myLocal.name = me.name || myLocal.name;
        myLocal.avatar = me.avatar || myLocal.avatar;
        setHud(myLocal.name, myLocal.avatar, myLocal.xp);
      }
    }
  });

  ws.addEventListener("close", () => {
    // ajouter un reconnect plus tard
    console.warn("WS closed");
  });
}

// Input : vecteur direction souris depuis le centre écran
let input = { dx: 0, dy: 0 };
window.addEventListener("mousemove", (e) => {
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const vx = e.clientX - cx;
  const vy = e.clientY - cy;
  const len = Math.hypot(vx, vy) || 1;
  input.dx = vx / len;
  input.dy = vy / len;
});

function sendInput() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "input", dx: input.dx, dy: input.dy }));
}

// Caméra centrée sur moi
function getMe() {
  return state.players.find(p => p.id === myId) || null;
}

function radiusFromMass(mass) {
  return 18 + Math.sqrt(mass) * 1.6;
}

function drawDustStar(x, y, size, color, alpha = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const radius = i % 2 === 0 ? size : size * 0.38;
    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawBackground(camX, camY) {
  const gradient = ctx.createRadialGradient(
    window.innerWidth * 0.5,
    window.innerHeight * 0.45,
    40,
    window.innerWidth * 0.5,
    window.innerHeight * 0.45,
    window.innerWidth * 0.9
  );
  gradient.addColorStop(0, "#1a1040");
  gradient.addColorStop(0.45, "#0d1739");
  gradient.addColorStop(1, "#03040b");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  ctx.save();
  ctx.translate(window.innerWidth / 2, window.innerHeight / 2);
  for (const s of backgroundStars) {
    const px = s.x - camX * s.drift;
    const py = s.y - camY * s.drift;
    const screenX = ((px + 6000) % 12000) - 6000;
    const screenY = ((py + 6000) % 12000) - 6000;
    ctx.beginPath();
    ctx.arc(screenX, screenY, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(210, 225, 255, ${s.glow})`;
    ctx.fill();
  }
  ctx.restore();
}

function drawBoundaryWarning(me, r) {
  if (!me) return;

  const minX = -state.world.w / 2;
  const maxX = state.world.w / 2;
  const minY = -state.world.h / 2;
  const maxY = state.world.h / 2;

  const warnings = [];
  if (me.x - minX < WARNING_MARGIN) warnings.push(Math.PI);
  if (maxX - me.x < WARNING_MARGIN) warnings.push(0);
  if (me.y - minY < WARNING_MARGIN) warnings.push(-Math.PI / 2);
  if (maxY - me.y < WARNING_MARGIN) warnings.push(Math.PI / 2);

  if (!warnings.length) return;

  const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(Date.now() * 0.012));
  for (const angle of warnings) {
    for (let i = -1; i <= 1; i++) {
      const a = angle + i * 0.25;
      const sx = me.x + Math.cos(a) * (r + 8);
      const sy = me.y + Math.sin(a) * (r + 8);
      const ex = me.x + Math.cos(a) * (r + 22);
      const ey = me.y + Math.sin(a) * (r + 22);

      ctx.strokeStyle = `rgba(255, 70, 70, ${0.65 * pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }
  }
}

function draw() {
  const me = getMe();
  const camX = me ? me.x : 0;
  const camY = me ? me.y : 0;

  drawBackground(camX, camY);

  // monde
  ctx.save();
  ctx.translate(window.innerWidth / 2, window.innerHeight / 2);
  ctx.translate(-camX, -camY);

  // poussière d'étoile (nourriture)
  for (const f of state.foods) {
    const isRare = f.kind === "rare";
    const size = isRare ? f.r * 1.15 : f.r * 0.95;
    const color = isRare ? "rgba(255, 228, 120, 0.96)" : "rgba(176, 120, 255, 0.9)";
    drawDustStar(f.x, f.y, size, color);
  }

  // joueurs
  for (const p of state.players) {
    const r = radiusFromMass(p.mass);

    // corps
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.id === myId ? "rgba(232,240,255,0.95)" : "rgba(220,230,255,0.65)";
    ctx.fill();

    const ring = ctx.createRadialGradient(p.x, p.y, r * 0.25, p.x, p.y, r);
    ring.addColorStop(0, "rgba(255,255,255,0.18)");
    ring.addColorStop(1, "rgba(145,170,255,0.03)");
    ctx.fillStyle = ring;
    ctx.fill();

    // nom
    ctx.font = `${Math.max(10, Math.min(20, r * 0.45))}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(10,18,35,0.85)";
    ctx.fillText(p.name, p.x, p.y + 4);

    if (p.id === myId) drawBoundaryWarning(p, r);
  }

  ctx.restore();

  requestAnimationFrame(draw);
}

twitchBtn.addEventListener("click", () => {
  startTwitchAuth().catch((err) => {
    console.error(err);
    authStatus.textContent = "Erreur Twitch: impossible de démarrer la connexion.";
  });
});

playBtn.addEventListener("click", () => {
  const profile = getSavedTwitchProfile();
  if (!profile) {
    authStatus.textContent = "Connecte-toi d'abord avec Twitch.";
    return;
  }

  myLocal.name = profile.login;
  myLocal.avatar = profile.avatar;
  myLocal.twitchId = profile.id;

  // HUD initial
  setHud(profile.login, profile.avatar, 0);

  const serverUrl = getServerUrl();
  connect(serverUrl, profile.login, profile.avatar, profile.id);

  menu.style.display = "none";

  // boucle input
  setInterval(sendInput, 50);
  requestAnimationFrame(draw);
});

(async () => {
  await maybeHandleTwitchRedirect();
  const profile = getSavedTwitchProfile();
  updateAuthStatus(profile);
})();
