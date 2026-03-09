const $ = (id) => document.getElementById(id);

const canvas = $("game");
const ctx = canvas.getContext("2d");

const menu = $("menu");
const playBtn = $("playBtn");
const twitchBtn = $("twitchBtn");
const authStatus = $("authStatus");
const menuAvatar = $("menuAvatar");
const menuPseudo = $("menuPseudo");
const menuXpFill = $("menuXpFill");
const menuXpText = $("menuXpText");
const gameStatus = $("gameStatus");
const hudProfile = $("hudProfile");
const hudTop10 = $("hudTop10");

const pseudoLabel = $("pseudoLabel");
const avatarImg = $("avatar");
const massLabel = $("massLabel");
const top10List = $("top10List");
const quitBtn = $("quitBtn");

const xpAnim = $("xpAnim");
const xpAnimAmount = $("xpAnimAmount");
const abilityHud = $("abilityHud");

const TWITCH_CLIENT_ID = "qjt85uubxukx6b0woq20r63sfermgz";
const TWITCH_REDIRECT_URI = `${window.location.origin}${window.location.pathname}`;
const TWITCH_SCOPES = ["user:read:email"];
const TWITCH_USE_IMPLICIT_FLOW = window.location.hostname.endsWith("github.io");
const TWITCH_STATE_KEY = "stellumin_twitch_state";
const TWITCH_CODE_VERIFIER_KEY = "stellumin_twitch_code_verifier";
const TWITCH_STORAGE_KEYS = {
  id: "stellumin_twitch_id",
  login: "stellumin_twitch_login",
  avatar: "stellumin_twitch_avatar"
};

let ws = null;
let myId = null;
let inputTimer = null;
let inGame = false;
let animationHandle = null;
let latestTop = [];
let statusState = { inGame: false, connectedPlayers: 0, maxPlayers: 30 };
let eliminationState = null;
const avatarVisualCache = new Map();
const avatarColorProbe = document.createElement("canvas");
avatarColorProbe.width = 20;
avatarColorProbe.height = 20;
const avatarColorCtx = avatarColorProbe.getContext("2d", { willReadFrequently: true });

let state = {
  players: [],
  foods: [],
  world: { w: 4000, h: 4000 }
};

let myLocal = {
  name: "Player",
  avatar: "",
  twitchId: "",
  globalXp: 0
};

const abilityState = {
  mass_eject: { id: "mass_eject", label: "Éjection de masse", key: "C", cooldownMs: 0, charges: Infinity, maxCharges: Infinity, availableAt: 0, disabled: false },
  stellar_impulse: { id: "stellar_impulse", label: "Impulsion stellaire", key: "Space", cooldownMs: 0, charges: 3, maxCharges: 3, rechargeMs: 30000, rechargeQueue: [], availableAt: 0, disabled: false },
  gravitation_pull: { id: "gravitation_pull", label: "Attraction gravitationnelle", key: "—", cooldownMs: Infinity, charges: 0, maxCharges: 0, availableAt: Infinity, disabled: true },
  orbital_comet: { id: "orbital_comet", label: "Comète orbitale", key: "—", cooldownMs: Infinity, charges: 0, maxCharges: 0, availableAt: Infinity, disabled: true }
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

async function parseTwitchError(response) {
  try {
    const payload = await response.json();
    const message = payload?.message || payload?.error_description || payload?.error;
    if (message) return `${response.status}: ${message}`;
  } catch (_) {
    // ignore JSON parse failures
  }
  return `${response.status}: ${response.statusText || "erreur inconnue"}`;
}

function getDefaultAvatarDataUrl() {
  return "data:image/svg+xml;utf8," + encodeURIComponent(`
    <svg xmlns=\"http://www.w3.org/2000/svg\" width=\"96\" height=\"96\">
      <rect width=\"100%\" height=\"100%\" fill=\"#111827\"/>
      <circle cx=\"48\" cy=\"42\" r=\"18\" fill=\"#93c5fd\"/>
      <rect x=\"22\" y=\"64\" width=\"52\" height=\"18\" rx=\"9\" fill=\"#1f2937\"/>
    </svg>
  `);
}

function updateAuthStatus(profile) {
  if (!profile) {
    authStatus.textContent = "Non connecté à Twitch.";
    twitchBtn.textContent = "Se connecter avec Twitch";
    playBtn.disabled = true;
    return;
  }

  authStatus.textContent = `Connecté en tant que ${profile.login} (ID: ${profile.id})`;
  twitchBtn.textContent = "Se déconnecter de Twitch";
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

async function fetchTwitchIdentity(accessToken) {
  const response = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: {
      Authorization: `OAuth ${accessToken}`
    }
  });

  if (!response.ok) {
    const details = await parseTwitchError(response);
    throw new Error(`Token Twitch invalide (${details}).`);
  }

  const identity = await response.json();
  if (!identity?.user_id || !identity?.login) {
    throw new Error("Token Twitch valide mais identité utilisateur absente.");
  }

  return {
    id: identity.user_id,
    login: identity.login
  };
}

async function fetchTwitchUser(accessToken) {
  const identity = await fetchTwitchIdentity(accessToken);

  const response = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(identity.id)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-ID": TWITCH_CLIENT_ID
    }
  });

  if (!response.ok) {
    const details = await parseTwitchError(response);
    console.warn(`Profil Twitch partiel: ${details}`);
    return {
      id: identity.id,
      login: identity.login,
      avatar: ""
    };
  }

  const json = await response.json();
  const user = json?.data?.[0];
  if (!user) {
    return {
      id: identity.id,
      login: identity.login,
      avatar: ""
    };
  }

  return {
    id: user.id || identity.id,
    login: user.display_name || user.login || identity.login,
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
    const details = await parseTwitchError(response);
    throw new Error(`Échange du code Twitch impossible (${details}).`);
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
    return { handled: true, success: false };
  }

  const code = queryParams.get("code");
  const token = hashParams.get("access_token");
  const stateValue = queryParams.get("state") || hashParams.get("state");

  if (!code && !token) {
    if (expectedState) {
      authStatus.textContent = "Connexion Twitch incomplète: aucun token/code reçu.";
      sessionStorage.removeItem(TWITCH_STATE_KEY);
      sessionStorage.removeItem(TWITCH_CODE_VERIFIER_KEY);
      return { handled: true, success: false };
    }
    return { handled: false, success: false };
  }

  sessionStorage.removeItem(TWITCH_STATE_KEY);

  if (!expectedState || stateValue !== expectedState) {
    authStatus.textContent = "Connexion Twitch invalide (state mismatch).";
    sessionStorage.removeItem(TWITCH_CODE_VERIFIER_KEY);
    window.history.replaceState({}, document.title, TWITCH_REDIRECT_URI);
    return { handled: true, success: false };
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
    hydrateProfile(profile);
    sendProgressRequest();
    return { handled: true, success: true };
  } catch (err) {
    console.error(err);
    const reason = err instanceof Error ? err.message : String(err);
    authStatus.textContent = `Erreur Twitch: ${reason}`;
    return { handled: true, success: false };
  } finally {
    window.history.replaceState({}, document.title, TWITCH_REDIRECT_URI);
  }
}

async function startTwitchAuth() {
  const stateValue = randomState();
  const verifier = randomCodeVerifier();
  sessionStorage.setItem(TWITCH_STATE_KEY, stateValue);
  sessionStorage.setItem(TWITCH_CODE_VERIFIER_KEY, verifier);

  const authUrl = new URL("https://id.twitch.tv/oauth2/authorize");
  authUrl.searchParams.set("client_id", TWITCH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", TWITCH_REDIRECT_URI);
  authUrl.searchParams.set("scope", TWITCH_SCOPES.join(" "));
  if (TWITCH_USE_IMPLICIT_FLOW) {
    authUrl.searchParams.set("response_type", "token");
  } else {
    const challenge = await createCodeChallenge(verifier);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
  }
  authUrl.searchParams.set("state", stateValue);

  window.location.href = authUrl.toString();
}

function xpForLevel(level) {
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

function renderGlobalProgress(xp) {
  const safeXp = Math.max(0, Math.floor(Number(xp) || 0));
  const { lvl, inLevelXp, next } = computeLevelFromXp(safeXp);
  menuXpText.textContent = `EXP globale · Niveau ${lvl} · ${inLevelXp} / ${next}`;
  menuXpFill.style.width = `${Math.floor((inLevelXp / next) * 100)}%`;
}

function renderMenuProfile() {
  menuPseudo.textContent = myLocal.name || "—";
  menuAvatar.src = myLocal.avatar || getDefaultAvatarDataUrl();
  renderGlobalProgress(myLocal.globalXp);
}

function renderHud() {
  pseudoLabel.textContent = myLocal.name || "—";
  avatarImg.src = myLocal.avatar || getDefaultAvatarDataUrl();

  const me = getMe();
  massLabel.textContent = me ? `${Math.floor(me.mass)}` : "0";
}

function renderStatus() {
  const { inGame: gameRunning, connectedPlayers, maxPlayers } = statusState;
  gameStatus.textContent = gameRunning
    ? `Partie en cours · ${connectedPlayers}/${maxPlayers} joueurs connectés`
    : "Aucune partie en cours · En attente du premier joueur";
}

function renderTopHud() {
  const entries = latestTop.slice(0, 10);
  const markup = entries.length
    ? entries.map((row) => `<li><span>#${row.rank} ${row.name}</span><strong>${row.mass}</strong></li>`).join("")
    : "<li><span>Aucun joueur actif</span><strong>—</strong></li>";

  top10List.innerHTML = markup;
}

function hydrateProfile(profile) {
  if (!profile) return;
  myLocal.name = profile.login;
  myLocal.avatar = profile.avatar;
  myLocal.twitchId = profile.id;
  renderMenuProfile();
  renderHud();
}

function showMenu() {
  inGame = false;
  eliminationState = null;
  myId = null;
  menu.style.display = "grid";
  quitBtn.style.display = "none";
  hudProfile.style.display = "none";
  hudTop10.style.display = "none";
  if (abilityHud) abilityHud.style.display = "none";
}

function hideMenu() {
  inGame = true;
  eliminationState = null;
  menu.style.display = "none";
  quitBtn.style.display = "block";
  hudProfile.style.display = "flex";
  hudTop10.style.display = "flex";
  if (abilityHud) abilityHud.style.display = "grid";
}

function connectLobby(serverUrl) {
  ws = new WebSocket(serverUrl);

  ws.addEventListener("open", () => {
    const profile = getSavedTwitchProfile();
    if (profile) {
      hydrateProfile(profile);
      sendProgressRequest();
    }
  });

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "status") {
      statusState = {
        inGame: !!msg.inGame,
        connectedPlayers: Number(msg.connectedPlayers) || 0,
        maxPlayers: Number(msg.maxPlayers) || 30
      };
      renderStatus();
      return;
    }

    if (msg.type === "progress") {
      myLocal.globalXp = Math.max(0, Number(msg.xp) || 0);
      renderMenuProfile();
      return;
    }

    if (msg.type === "join_rejected") {
      authStatus.textContent = "Serveur plein (30 joueurs). Réessaie plus tard.";
      showMenu();
      return;
    }

    if (msg.type === "joined") {
      myId = msg.id;
      hideMenu();
      return;
    }

    if (msg.type === "eliminated") {
      eliminationState = {
        active: true,
        startedAt: Date.now(),
        durationMs: Math.max(500, Number(msg.durationMs) || 5000),
        camX: Number(msg.camera?.x) || 0,
        camY: Number(msg.camera?.y) || 0,
        mass: Number(msg.camera?.mass) || 10
      };
      myId = null;
      return;
    }

    if (msg.type === "run_end") {
      showMenu();
      animateXpGain(msg.earnedXp || 0, msg.totalXp || myLocal.globalXp);
      return;
    }

    if (msg.type === "state") {
      state.players = msg.players || [];
      state.foods = msg.foods || [];
      state.world = msg.world || state.world;
      latestTop = msg.top || [];

      renderTopHud();
      renderHud();
    }
  });

  ws.addEventListener("close", () => {
    inGame = false;
    myId = null;
    renderStatus();
    setTimeout(() => connectLobby(serverUrl), 1200);
  });
}

function sendProgressRequest() {
  if (!ws || ws.readyState !== 1 || !myLocal.twitchId) return;
  ws.send(JSON.stringify({
    type: "progress_request",
    twitchId: myLocal.twitchId,
    name: myLocal.name,
    avatar: myLocal.avatar
  }));
}

function joinGame() {
  if (!ws || ws.readyState !== 1) {
    authStatus.textContent = "Connexion serveur indisponible.";
    return;
  }
  if (!myLocal.twitchId) {
    authStatus.textContent = "Connecte-toi d'abord avec Twitch.";
    return;
  }

  ws.send(JSON.stringify({
    type: "join",
    name: myLocal.name,
    avatar: myLocal.avatar,
    twitchId: myLocal.twitchId
  }));
}

function leaveGame() {
  if (!ws || ws.readyState !== 1) {
    showMenu();
    return;
  }
  ws.send(JSON.stringify({ type: "leave" }));
}

function animateXpGain(amount, totalAfter) {
  const gain = Math.max(0, Math.floor(Number(amount) || 0));
  myLocal.globalXp = Math.max(0, Math.floor(Number(totalAfter) || 0));
  renderMenuProfile();

  if (!gain) return;
  xpAnimAmount.textContent = `+${gain} EXP`;
  xpAnim.classList.add("show");
  setTimeout(() => xpAnim.classList.remove("show"), 2600);
}

function consumeImpulseCharge() {
  const ability = abilityState.stellar_impulse;
  const now = Date.now();
  ability.rechargeQueue = ability.rechargeQueue.filter((t) => t > now);
  const available = Math.max(0, ability.maxCharges - ability.rechargeQueue.length);
  if (available <= 0) return false;
  ability.rechargeQueue.push(now + ability.rechargeMs);
  return true;
}

function computeImpulseCharges() {
  const ability = abilityState.stellar_impulse;
  const now = Date.now();
  ability.rechargeQueue = ability.rechargeQueue.filter((t) => t > now);
  return Math.max(0, ability.maxCharges - ability.rechargeQueue.length);
}

function getCooldownText(ability) {
  if (ability.disabled) return "CD: —";
  if (ability.id === "stellar_impulse") {
    const charges = computeImpulseCharges();
    if (charges > 0) return "CD: 0s";
    const next = Math.min(...ability.rechargeQueue);
    const sec = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    return `CD: ${sec}s`;
  }
  return "CD: 0s";
}

function renderAbilityHud() {
  if (!abilityHud) return;
  const slots = abilityHud.querySelectorAll(".abilitySlot");
  for (const slot of slots) {
    const id = slot.dataset.ability;
    const ability = abilityState[id];
    if (!ability) continue;

    const chargesEl = slot.querySelector(".abilityCharges");
    const cooldownEl = slot.querySelector(".abilityCooldown");
    const stateEl = slot.querySelector(".abilityState");

    slot.classList.remove("is-cooldown", "is-unavailable");

    if (ability.disabled) {
      chargesEl.textContent = "Charges: —";
      cooldownEl.textContent = "CD: —";
      stateEl.textContent = "Bientôt disponible";
      slot.classList.add("is-unavailable");
      continue;
    }

    if (ability.id === "mass_eject") {
      chargesEl.textContent = "Charges: ∞";
      cooldownEl.textContent = "CD: 0s";
      stateEl.textContent = "Prêt";
      continue;
    }

    if (ability.id === "stellar_impulse") {
      const charges = computeImpulseCharges();
      chargesEl.textContent = `Charges: ${charges}/${ability.maxCharges}`;
      cooldownEl.textContent = getCooldownText(ability);
      if (charges > 0) {
        stateEl.textContent = "Prêt";
      } else {
        stateEl.textContent = "Cooldown";
        slot.classList.add("is-cooldown");
      }
    }
  }
}

function tryUseAbility(abilityId) {
  if (!inGame || !myId || !ws || ws.readyState !== 1) return;

  const dirX = input.dx || 1;
  const dirY = input.dy || 0;

  if (abilityId === "stellar_impulse") {
    const ok = consumeImpulseCharge();
    if (!ok) {
      renderAbilityHud();
      return;
    }
  }

  ws.send(JSON.stringify({
    type: "ability_use",
    ability: abilityId,
    dx: dirX,
    dy: dirY
  }));

  renderAbilityHud();
}


let input = { dx: 0, dy: 0, mag: 0 };
window.addEventListener("mousemove", (e) => {
  if (!inGame) return;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;
  const vx = e.clientX - cx;
  const vy = e.clientY - cy;
  const len = Math.hypot(vx, vy);

  if (len <= 8) {
    input.dx = 0;
    input.dy = 0;
    input.mag = 0;
    return;
  }

  const norm = len || 1;
  input.dx = vx / norm;
  input.dy = vy / norm;

  const maxReach = Math.min(window.innerWidth, window.innerHeight) * 0.44;
  input.mag = Math.max(0, Math.min(1, len / maxReach));
});

window.addEventListener("wheel", (e) => {
  if (!inGame) return;
  e.preventDefault();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.code === "KeyC") {
    tryUseAbility("mass_eject");
  } else if (e.code === "Space") {
    e.preventDefault();
    tryUseAbility("stellar_impulse");
  }
});

function sendInput() {
  if (!inGame || !ws || ws.readyState !== 1 || !myId) return;
  ws.send(JSON.stringify({ type: "input", dx: input.dx, dy: input.dy, mag: input.mag }));
}

function getMe() {
  return state.players.find((p) => p.id === myId) || null;
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

function hashColorFromString(text = "") {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { r: 170 + Math.floor((hue % 40) * 2), g: 120 + (hue % 90), b: 180 + (hue % 70) };
}

function getAvatarVisual(avatarUrl) {
  const key = avatarUrl || "__default__";
  if (avatarVisualCache.has(key)) return avatarVisualCache.get(key);

  const fallbackColor = hashColorFromString(key);
  const visual = { img: null, color: fallbackColor, ready: !avatarUrl };
  avatarVisualCache.set(key, visual);

  if (!avatarUrl) return visual;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    visual.img = img;
    if (!avatarColorCtx) {
      visual.ready = true;
      return;
    }

    avatarColorCtx.clearRect(0, 0, avatarColorProbe.width, avatarColorProbe.height);
    avatarColorCtx.drawImage(img, 0, 0, avatarColorProbe.width, avatarColorProbe.height);
    const pixels = avatarColorCtx.getImageData(0, 0, avatarColorProbe.width, avatarColorProbe.height).data;

    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3] / 255;
      if (alpha < 0.2) continue;
      r += pixels[i] * alpha;
      g += pixels[i + 1] * alpha;
      b += pixels[i + 2] * alpha;
      count += alpha;
    }

    if (count > 0) {
      visual.color = {
        r: Math.floor(r / count),
        g: Math.floor(g / count),
        b: Math.floor(b / count)
      };
    }
    visual.ready = true;
  };
  img.onerror = () => {
    visual.ready = true;
  };
  img.src = avatarUrl;

  return visual;
}

function drawPlayerRadiance(player, r, color) {
  const flow = 0.92 + 0.08 * Math.sin(Date.now() * 0.003 + player.mass * 0.015);
  const outerRadius = r * 1.46 * flow;

  const aura = ctx.createRadialGradient(player.x, player.y, r * 0.72, player.x, player.y, outerRadius);
  aura.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, 0.25)`);
  aura.addColorStop(0.7, `rgba(${color.r}, ${color.g}, ${color.b}, 0.11)`);
  aura.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(player.x, player.y, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  const ringRadius = r * (1.08 + 0.02 * Math.sin(Date.now() * 0.004 + player.mass));
  ctx.strokeStyle = `rgba(${Math.min(255, color.r + 36)}, ${Math.min(255, color.g + 36)}, ${Math.min(255, color.b + 36)}, 0.32)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(player.x, player.y, ringRadius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPlayerCore(player, r) {
  const visual = getAvatarVisual(player.avatar);
  const color = visual.color;

  drawPlayerRadiance(player, r, color);

  ctx.save();
  ctx.beginPath();
  ctx.arc(player.x, player.y, r, 0, Math.PI * 2);
  ctx.clip();

  if (visual.img && visual.img.complete) {
    ctx.drawImage(visual.img, player.x - r, player.y - r, r * 2, r * 2);
  } else {
    const fallback = ctx.createLinearGradient(player.x - r, player.y - r, player.x + r, player.y + r);
    fallback.addColorStop(0, `rgba(${Math.min(255, color.r + 35)}, ${Math.min(255, color.g + 35)}, ${Math.min(255, color.b + 35)}, 0.95)`);
    fallback.addColorStop(1, `rgba(${Math.max(0, color.r - 25)}, ${Math.max(0, color.g - 25)}, ${Math.max(0, color.b - 25)}, 0.95)`);
    ctx.fillStyle = fallback;
    ctx.fillRect(player.x - r, player.y - r, r * 2, r * 2);
  }

  const shine = ctx.createRadialGradient(player.x - r * 0.35, player.y - r * 0.45, r * 0.1, player.x, player.y, r * 1.1);
  shine.addColorStop(0, "rgba(255,255,255,0.33)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(player.x - r, player.y - r, r * 2, r * 2);
  ctx.restore();

  ctx.lineWidth = 2.3;
  ctx.strokeStyle = "rgba(255,255,255,0.48)";
  ctx.beginPath();
  ctx.arc(player.x, player.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function getCameraScaleForMass(mass) {
  const safeMass = Math.max(10, Number(mass) || 10);
  const growthFactor = Math.max(0, Math.log2(safeMass / 10));
  const zoomOut = Math.min(0.12, growthFactor * 0.016);
  return 1.42 - zoomOut;
}

function getCameraPose() {
  const me = getMe();
  const followMass = me ? me.mass : (eliminationState?.mass || 10);
  const baseScale = getCameraScaleForMass(followMass);

  if (!eliminationState || !eliminationState.active) {
    return {
      camX: me ? me.x : 0,
      camY: me ? me.y : 0,
      scale: baseScale
    };
  }

  const elapsed = Date.now() - eliminationState.startedAt;
  const t = Math.min(1, elapsed / eliminationState.durationMs);
  const ease = t * t * (3 - 2 * t);

  return {
    camX: eliminationState.camX,
    camY: eliminationState.camY,
    scale: baseScale * (1 - 0.06 * ease)
  };
}


function drawImpulseSignal(player, radius) {
  const until = Number(player.impulseSignalUntil) || 0;
  if (until <= Date.now()) return;

  const dir = player.impulseSignalDir;
  if (!dir) return;

  const t = Math.max(0, Math.min(1, (until - Date.now()) / 750));
  const pulse = 0.55 + 0.45 * Math.sin(Date.now() * 0.02);
  const len = radius + 16 + (1 - t) * 18;
  const alpha = 0.18 + 0.2 * pulse;

  ctx.strokeStyle = `rgba(180, 245, 255, ${alpha})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(player.x + dir.dx * (radius * 0.55), player.y + dir.dy * (radius * 0.55));
  ctx.lineTo(player.x + dir.dx * len, player.y + dir.dy * len);
  ctx.stroke();

  const tx = player.x + dir.dx * len;
  const ty = player.y + dir.dy * len;
  ctx.fillStyle = `rgba(180, 245, 255, ${Math.min(0.5, alpha + 0.08)})`;
  drawDustStar(tx, ty, 6, ctx.fillStyle, 1);
}

function draw() {
  const { camX, camY, scale } = getCameraPose();
  drawBackground(camX, camY);

  if (!inGame) {
    animationHandle = requestAnimationFrame(draw);
    return;
  }

  ctx.save();
  ctx.translate(window.innerWidth / 2, window.innerHeight / 2);
  ctx.scale(scale, scale);
  ctx.translate(-camX, -camY);

  for (const f of state.foods) {
    const isRare = f.kind === "rare";
    const isEjected = f.kind === "ejected";
    const size = isRare ? f.r * 1.15 : (isEjected ? f.r * 1.05 : f.r * 0.95);
    const color = isRare
      ? "rgba(255, 228, 120, 0.96)"
      : (isEjected ? "rgba(128, 245, 255, 0.95)" : "rgba(176, 120, 255, 0.9)");
    drawDustStar(f.x, f.y, size, color);
  }

  const me = getMe();
  for (const p of state.players) {
    const r = radiusFromMass(p.mass);
    drawPlayerCore(p, r);
    drawImpulseSignal(p, r);

    ctx.font = `${Math.max(10, Math.min(20, r * 0.4))}px system-ui`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(8, 12, 24, 0.88)";
    ctx.fillText(p.name, p.x, p.y + r + 16);

    if (me && p.id === me.id) drawBoundaryWarning(p, r);
  }

  ctx.restore();
  animationHandle = requestAnimationFrame(draw);
}

twitchBtn.addEventListener("click", () => {
  const profile = getSavedTwitchProfile();
  if (profile) {
    localStorage.removeItem(TWITCH_STORAGE_KEYS.id);
    localStorage.removeItem(TWITCH_STORAGE_KEYS.login);
    localStorage.removeItem(TWITCH_STORAGE_KEYS.avatar);
    myLocal = {
      name: "Player",
      avatar: "",
      twitchId: "",
      globalXp: 0
    };
    updateAuthStatus(null);
    renderMenuProfile();
    renderHud();
    return;
  }

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

  hydrateProfile(profile);
  joinGame();
});

quitBtn.addEventListener("click", leaveGame);

(async () => {
  const serverUrl = getServerUrl();
  connectLobby(serverUrl);

  const authResult = await maybeHandleTwitchRedirect();
  if (authResult.handled && !authResult.success) return;

  const profile = getSavedTwitchProfile();
  updateAuthStatus(profile);
  hydrateProfile(profile);

  if (profile) {
    sendProgressRequest();
  }

  showMenu();
  renderStatus();
  renderTopHud();
  if (!animationHandle) animationHandle = requestAnimationFrame(draw);

  if (!inputTimer) inputTimer = setInterval(sendInput, 50);
  setInterval(renderAbilityHud, 120);
  renderAbilityHud();
})();
