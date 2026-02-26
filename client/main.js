const $ = (id) => document.getElementById(id);

const canvas = $("game");
const ctx = canvas.getContext("2d");

const menu = $("menu");
const playBtn = $("playBtn");
const pseudoInput = $("pseudoInput");
const avatarInput = $("avatarInput");

const pseudoLabel = $("pseudoLabel");
const avatarImg = $("avatar");
const xpFill = $("xpFill");
const xpText = $("xpText");
const levelLabel = $("levelLabel");

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
  xp: 0,
  level: 1
};

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

function loadProfile() {
  const savedName = localStorage.getItem("stellumin_name");
  const savedAvatar = localStorage.getItem("stellumin_avatar");
  if (savedName) pseudoInput.value = savedName;
  if (savedAvatar) avatarInput.value = savedAvatar;
}
loadProfile();

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

function connect(serverUrl, name, avatar) {
  ws = new WebSocket(serverUrl);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "join", name, avatar }));
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

function draw() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  const me = getMe();
  const camX = me ? me.x : 0;
  const camY = me ? me.y : 0;

  // fond + grille légère
  ctx.save();
  ctx.translate(window.innerWidth / 2, window.innerHeight / 2);
  ctx.translate(-camX, -camY);

  // grille
  ctx.globalAlpha = 0.18;
  ctx.lineWidth = 1;
  const step = 120;
  const left = camX - window.innerWidth;
  const right = camX + window.innerWidth;
  const top = camY - window.innerHeight;
  const bottom = camY + window.innerHeight;

  ctx.beginPath();
  for (let x = Math.floor(left / step) * step; x <= right; x += step) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = Math.floor(top / step) * step; y <= bottom; y += step) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.strokeStyle = "rgba(160,210,255,0.35)";
  ctx.stroke();
  ctx.globalAlpha = 1;

  // nourriture
  for (const f of state.foods) {
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(160,210,255,0.85)";
    ctx.fill();
  }

  // joueurs
  for (const p of state.players) {
    const r = radiusFromMass(p.mass);

    // corps
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.id === myId ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.60)";
    ctx.fill();

    // nom
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.75)";
    ctx.fillText(p.name, p.x, p.y + 4);
  }

  ctx.restore();

  requestAnimationFrame(draw);
}

playBtn.addEventListener("click", () => {
  const name = (pseudoInput.value || "Player").trim().slice(0, 20);
  const avatar = (avatarInput.value || "").trim().slice(0, 400);

  localStorage.setItem("stellumin_name", name);
  localStorage.setItem("stellumin_avatar", avatar);

  myLocal.name = name;
  myLocal.avatar = avatar;

  // HUD initial
  setHud(name, avatar, 0);

  // Connect (à remplacer par l'URL Fly une fois déployé)
  // En local : ws://localhost:8080
  const serverUrl = "wss://stellumin-server.fly.dev";
  connect(serverUrl, name, avatar);

  menu.style.display = "none";

  // boucle input
  setInterval(sendInput, 50);
  requestAnimationFrame(draw);
});
