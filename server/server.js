import { WebSocketServer } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;

// Monde
const WORLD_W = 4000;
const WORLD_H = 4000;

// Nourriture
const FOOD_TARGET = 1200;
const FOOD_RADIUS = 5;
const COMMON_FOOD_MASS = 1;
const RARE_FOOD_MASS = 10;
const RARE_FOOD_CHANCE = 0.06;

// Joueurs
const BASE_RADIUS = 18;
const SPEED = 360; // unités/s (sera ralenti par la masse)
const DRAG = 0.92;
const START_MASS = 10;

// Persistance
const DATA_DIR = path.resolve("./data");
const PLAYER_STORE_PATH = path.join(DATA_DIR, "player-progress.json");

// Util
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

function radiusFromMass(mass) {
  // croissance douce, évite les énormes discontinuités
  return BASE_RADIUS + Math.sqrt(mass) * 1.6;
}

function speedFromMass(mass) {
  // plus tu es gros, plus tu es lent
  return SPEED / (1 + Math.sqrt(mass) * 0.09);
}

function makeFood() {
  const isRare = Math.random() < RARE_FOOD_CHANCE;
  return {
    id: cryptoRandomId(),
    x: rand(-WORLD_W / 2, WORLD_W / 2),
    y: rand(-WORLD_H / 2, WORLD_H / 2),
    r: FOOD_RADIUS,
    kind: isRare ? "rare" : "common",
    mass: isRare ? RARE_FOOD_MASS : COMMON_FOOD_MASS
  };
}

function cryptoRandomId() {
  // fallback sans crypto web (node ok)
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const wss = new WebSocketServer({ port: PORT });

/**
 * players: id -> {
 *   id, accountId, name, avatar, x,y, vx,vy, mass, xp, input {dx,dy}
 * }
 */
const players = new Map();
const sockets = new Map(); // ws -> playerId
const progressByAccount = new Map();
let saveTimer = null;

let foods = [];
for (let i = 0; i < FOOD_TARGET; i++) foods.push(makeFood());

async function loadProgress() {
  try {
    const raw = await readFile(PLAYER_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    for (const [accountId, record] of Object.entries(parsed)) {
      if (!record || typeof record !== "object") continue;
      progressByAccount.set(accountId, {
        xp: Math.max(0, Number(record.xp) || 0),
        mass: Math.max(START_MASS, Number(record.mass) || START_MASS),
        name: typeof record.name === "string" ? record.name.slice(0, 20) : "",
        avatar: typeof record.avatar === "string" ? record.avatar.slice(0, 400) : "",
        updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString()
      });
    }
    console.log(`Loaded ${progressByAccount.size} player progress records.`);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.log("No existing player progress store yet.");
      return;
    }
    console.error("Failed to load player progress:", err);
  }
}

async function flushProgressToDisk() {
  const output = {};
  for (const [accountId, record] of progressByAccount.entries()) {
    output[accountId] = record;
  }

  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PLAYER_STORE_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error("Failed to save player progress:", err);
  }
}

function scheduleProgressSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await flushProgressToDisk();
  }, 1500);
}

function persistPlayerProgress(player) {
  if (!player?.accountId) return;

  progressByAccount.set(player.accountId, {
    xp: Math.max(0, Math.floor(player.xp || 0)),
    mass: Math.max(START_MASS, Number(player.mass) || START_MASS),
    name: typeof player.name === "string" ? player.name.slice(0, 20) : "",
    avatar: typeof player.avatar === "string" ? player.avatar.slice(0, 400) : "",
    updatedAt: new Date().toISOString()
  });

  scheduleProgressSave();
}

function applySavedProgress(player) {
  const saved = progressByAccount.get(player.accountId);
  if (!saved) return;

  player.xp = Math.max(0, Number(saved.xp) || 0);
  player.mass = Math.max(START_MASS, Number(saved.mass) || START_MASS);
}

function snapshotForClient() {
  // Snapshot volontairement simple (pas opti)
  const ps = [];
  for (const p of players.values()) {
    ps.push({
      id: p.id,
      accountId: p.accountId,
      name: p.name,
      avatar: p.avatar,
      x: p.x,
      y: p.y,
      mass: p.mass,
      xp: p.xp
    });
  }
  return {
    t: Date.now(),
    world: { w: WORLD_W, h: WORLD_H },
    players: ps,
    foods
  };
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello", msg: "stellumin-server" }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join") {
      const id = cryptoRandomId();
      const name = typeof msg.name === "string" ? msg.name.slice(0, 20) : "Player";
      const avatar = typeof msg.avatar === "string" ? msg.avatar.slice(0, 400) : "";
      const twitchId = typeof msg.twitchId === "string" ? msg.twitchId.slice(0, 64) : "";

      const p = {
        id,
        accountId: twitchId || id,
        name,
        avatar,
        x: rand(-500, 500),
        y: rand(-500, 500),
        vx: 0,
        vy: 0,
        mass: START_MASS,
        xp: 0,
        input: { dx: 0, dy: 0 }
      };

      applySavedProgress(p);

      players.set(id, p);
      sockets.set(ws, id);

      ws.send(JSON.stringify({ type: "joined", id }));
      return;
    }

    if (msg.type === "input") {
      const pid = sockets.get(ws);
      if (!pid) return;
      const p = players.get(pid);
      if (!p) return;

      // dx, dy dans [-1, 1]
      const dx = clamp(Number(msg.dx) || 0, -1, 1);
      const dy = clamp(Number(msg.dy) || 0, -1, 1);
      p.input.dx = dx;
      p.input.dy = dy;
      return;
    }
  });

  ws.on("close", () => {
    const pid = sockets.get(ws);
    sockets.delete(ws);
    if (!pid) return;

    const player = players.get(pid);
    if (player) {
      persistPlayerProgress(player);
      players.delete(pid);
    }
  });
});

// Simulation
setInterval(() => {
  // maintenir la nourriture
  while (foods.length < FOOD_TARGET) foods.push(makeFood());

  // update joueurs
  for (const p of players.values()) {
    const sp = speedFromMass(p.mass);

    // accélération vers input
    p.vx = p.vx * DRAG + p.input.dx * sp * (1 - DRAG);
    p.vy = p.vy * DRAG + p.input.dy * sp * (1 - DRAG);

    p.x += p.vx * DT;
    p.y += p.vy * DT;

    // limites monde
    p.x = clamp(p.x, -WORLD_W / 2, WORLD_W / 2);
    p.y = clamp(p.y, -WORLD_H / 2, WORLD_H / 2);

    // collisions nourriture (simple O(n))
    const pr = radiusFromMass(p.mass);
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      if (dist2(p.x, p.y, f.x, f.y) <= (pr + f.r) * (pr + f.r)) {
        foods.splice(i, 1);
        p.mass += f.mass;
        p.xp += f.mass; // XP = masse ramassée
        persistPlayerProgress(p);
      }
    }
  }

  broadcast({ type: "state", ...snapshotForClient() });
}, 1000 / TICK_HZ);

await loadProgress();
console.log(`Stellumin.io server listening on :${PORT}`);
