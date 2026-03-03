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

const WARNING_MARGIN = 300;
const backgroundStars = Array.from({ length: 260 }, () => ({
  x: Math.random() * 7000 - 3500,
  y: Math.random() * 7000 - 3500,
  r: Math.random() * 1.7 + 0.4,
  glow: Math.random() * 0.55 + 0.2,
  drift: Math.random() * 0.35 + 0.65
}));

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
  const serverUrl = "ws://localhost:8080";
  connect(serverUrl, name, avatar);

  menu.style.display = "none";

  // boucle input
  setInterval(sendInput, 50);
  requestAnimationFrame(draw);
});
