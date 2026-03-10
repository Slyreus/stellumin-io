import { WebSocketServer } from "ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;
const MAX_PLAYERS = 30;

const WORLD_W = 4000;
const WORLD_H = 4000;

const FOOD_TARGET = 1200;
const FOOD_RADIUS = 5;
const COMMON_FOOD_MASS = 1;
const RARE_FOOD_MASS = 10;
const RARE_FOOD_CHANCE = 0.06;

const BASE_RADIUS = 18;
const SPEED = 360;
const DRAG = 0.92;
const START_MASS = 10;
const MASS_TO_GLOBAL_XP_RATE = 0.35;

const MASS_EJECT_MIN_RATIO = 0.01;
const MASS_EJECT_MAX_RATIO = 0.02;
const MASS_EJECT_MIN = 1.2;
const MASS_EJECT_SPEED = 620;
const EJECTED_DRAG = 0.9;

const IMPULSE_RATIO = 0.10;
const IMPULSE_MIN = 4;
const IMPULSE_PUSH = 440;
const IMPULSE_TELEGRAPH_MS = 1000;
const IMPULSE_CHARGES = 3;
const IMPULSE_RECHARGE_MS = 30000;
const IMPULSE_CHUNK_TARGET = 22;

const ADMIN_TWITCH_ID = "80576726";

const DATA_DIR = path.resolve("./data");
const PLAYER_STORE_PATH = path.join(DATA_DIR, "player-progress.json");

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};

function radiusFromMass(mass) {
  const safeMass = Math.max(1, Number(mass) || 1);
  return BASE_RADIUS + Math.pow(safeMass, 0.9) * 0.14;
}

function speedFromMass(mass) {
  return SPEED / (1 + Math.sqrt(mass) * 0.09);
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function makeFood() {
  const isRare = Math.random() < RARE_FOOD_CHANCE;
  return {
    id: cryptoRandomId(),
    x: rand(-WORLD_W / 2, WORLD_W / 2),
    y: rand(-WORLD_H / 2, WORLD_H / 2),
    r: FOOD_RADIUS,
    kind: isRare ? "rare" : "common",
    mass: isRare ? RARE_FOOD_MASS : COMMON_FOOD_MASS,
    grantSessionGain: true,
    vx: 0,
    vy: 0
  };
}

function pickSpawnPoint() {
  if (!players.size) {
    return { x: rand(-WORLD_W / 2, WORLD_W / 2), y: rand(-WORLD_H / 2, WORLD_H / 2) };
  }

  let best = null;
  for (let i = 0; i < 36; i++) {
    const candidate = {
      x: rand(-WORLD_W / 2, WORLD_W / 2),
      y: rand(-WORLD_H / 2, WORLD_H / 2)
    };

    let score = 0;
    for (const p of players.values()) {
      const d2 = dist2(candidate.x, candidate.y, p.x, p.y);
      if (d2 < 1) {
        score += 999999;
        continue;
      }
      score += (1 + Math.sqrt(p.mass)) / Math.sqrt(d2);
    }

    if (!best || score < best.score) {
      best = { ...candidate, score };
    }
  }

  return { x: best.x, y: best.y };
}


function normalizeDir(dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  return { dx: dx / len, dy: dy / len };
}

function radiusFromLooseMass(mass) {
  return Math.max(4, FOOD_RADIUS + Math.sqrt(Math.max(0.1, mass)) * 1.1);
}

function makeEjectedMass({ x, y, dx, dy, mass, speed, grantSessionGain = false }) {
  return {
    id: cryptoRandomId(),
    x,
    y,
    r: radiusFromLooseMass(mass),
    kind: "ejected",
    mass,
    grantSessionGain,
    vx: dx * speed,
    vy: dy * speed
  };
}


function splitMass(totalMass, targetChunk) {
  const chunks = [];
  let remaining = Math.max(0, totalMass);
  while (remaining > 0.001) {
    const chunk = Math.min(remaining, targetChunk);
    chunks.push(chunk);
    remaining -= chunk;
  }
  return chunks;
}

function spawnEjectedChunks(player, dir, totalMass, speed, distance, jitter = 0.06) {
  const pr = radiusFromMass(player.mass);
  const chunks = splitMass(totalMass, IMPULSE_CHUNK_TARGET);
  for (const mass of chunks) {
    const offset = rand(-jitter, jitter);
    const jx = dir.dx + offset;
    const jy = dir.dy - offset;
    const nd = normalizeDir(jx, jy);
    const distOffset = rand(-6, 10);
    const speedScale = rand(0.9, 1.08);
    foods.push(makeEjectedMass({
      x: clamp(player.x + nd.dx * (pr + distance + distOffset), -WORLD_W / 2, WORLD_W / 2),
      y: clamp(player.y + nd.dy * (pr + distance + distOffset), -WORLD_H / 2, WORLD_H / 2),
      dx: nd.dx,
      dy: nd.dy,
      mass,
      speed: speed * speedScale
    }));
  }
}
function availableImpulseCharges(player) {
  const now = Date.now();
  player.impulseRecharge = player.impulseRecharge.filter((t) => t > now);
  return Math.max(0, IMPULSE_CHARGES - player.impulseRecharge.length);
}

function tryConsumeImpulseCharge(player) {
  if (availableImpulseCharges(player) <= 0) return false;
  player.impulseRecharge.push(Date.now() + IMPULSE_RECHARGE_MS);
  return true;
}

function castMassEject(player, dir) {
  const ratio = rand(MASS_EJECT_MIN_RATIO, MASS_EJECT_MAX_RATIO);
  const cost = Math.max(MASS_EJECT_MIN, player.mass * ratio);
  if (player.mass - cost < 6) return false;

  player.mass -= cost;
  spawnEjectedChunks(player, dir, cost, MASS_EJECT_SPEED, 10, 0.04);
  return true;
}

function castStellarImpulse(player, dir) {
  if (!tryConsumeImpulseCharge(player)) return false;

  const cost = Math.max(IMPULSE_MIN, player.mass * IMPULSE_RATIO);
  if (player.mass - cost < 6) {
    player.impulseRecharge.pop();
    return false;
  }

  const executeAt = Date.now() + IMPULSE_TELEGRAPH_MS;
  player.pendingImpulses.push({ executeAt, dir, massCost: cost });
  player.impulseSignal = { until: executeAt, dir };
  return true;
}

function resolvePendingImpulses(player) {
  if (!player.pendingImpulses.length) return;
  const now = Date.now();
  const remaining = [];

  for (const pending of player.pendingImpulses) {
    if (pending.executeAt > now) {
      remaining.push(pending);
      continue;
    }

    const cost = Math.max(IMPULSE_MIN, pending.massCost);
    if (player.mass - cost < 6) continue;

    player.mass -= cost;
    spawnEjectedChunks(player, { dx: -pending.dir.dx, dy: -pending.dir.dy }, cost, MASS_EJECT_SPEED * 0.72, 12, 0.18);
    player.vx += pending.dir.dx * IMPULSE_PUSH;
    player.vy += pending.dir.dy * IMPULSE_PUSH;
  }

  player.pendingImpulses = remaining;
  if (player.impulseSignal && player.impulseSignal.until <= now) {
    player.impulseSignal = null;
  }
}
const wss = new WebSocketServer({ port: PORT });
const players = new Map();
const sockets = new Map();
const playerSocketById = new Map();
const pendingEliminations = new Map();
const progressByAccount = new Map();
const wsMeta = new Map();
const bannedAccounts = new Set();
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
  for (const [accountId, record] of progressByAccount.entries()) output[accountId] = record;

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

function getOrCreateProgress(accountId, name = "", avatar = "") {
  const safeId = accountId || "";
  if (!safeId) return { xp: 0, name, avatar };

  let progress = progressByAccount.get(safeId);
  if (!progress) {
    progress = {
      xp: 0,
      name: name.slice(0, 20),
      avatar: avatar.slice(0, 400),
      updatedAt: new Date().toISOString()
    };
    progressByAccount.set(safeId, progress);
    scheduleProgressSave();
  }
  return progress;
}

function sendToSocket(ws, payload) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
}

function upsertProgress(accountId, patch) {
  if (!accountId) return;
  const current = getOrCreateProgress(accountId);
  progressByAccount.set(accountId, {
    xp: Math.max(0, Number(patch.xp ?? current.xp) || 0),
    name: typeof patch.name === "string" ? patch.name.slice(0, 20) : current.name,
    avatar: typeof patch.avatar === "string" ? patch.avatar.slice(0, 400) : current.avatar,
    updatedAt: new Date().toISOString()
  });
  scheduleProgressSave();
}

function finalizeRunEndForPlayer(player, reason) {
  if (!player) return;

  const playerId = player.id;
  const earnedXp = Math.max(0, Math.floor(player.sessionMassGained * MASS_TO_GLOBAL_XP_RATE));
  const progress = getOrCreateProgress(player.accountId, player.name, player.avatar);
  const totalXp = progress.xp + earnedXp;

  upsertProgress(player.accountId, {
    xp: totalXp,
    name: player.name,
    avatar: player.avatar
  });

  const ws = playerSocketById.get(playerId);
  sendToSocket(ws, {
    type: "run_end",
    reason,
    earnedXp,
    totalXp
  });

  players.delete(playerId);
  playerSocketById.delete(playerId);
}

function awardGlobalXpAndRemove(playerId, reason) {
  const player = players.get(playerId);
  if (!player) return;
  finalizeRunEndForPlayer(player, reason);
}

function scheduleEliminationRunEnd(playerId, reason = "eaten", delayMs = 5000) {
  const player = players.get(playerId);
  if (!player) return;

  const ws = playerSocketById.get(playerId);
  sendToSocket(ws, {
    type: "eliminated",
    reason,
    durationMs: delayMs,
    camera: {
      x: player.x,
      y: player.y,
      mass: player.mass
    }
  });

  players.delete(playerId);

  const existingTimer = pendingEliminations.get(playerId);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    pendingEliminations.delete(playerId);
    finalizeRunEndForPlayer(player, reason);
  }, delayMs);

  pendingEliminations.set(playerId, timer);
}

function statusForClient() {
  return {
    type: "status",
    inGame: players.size > 0,
    connectedPlayers: players.size,
    maxPlayers: MAX_PLAYERS
  };
}

function snapshotForClient() {
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
      impulseSignalUntil: p.impulseSignal?.until || 0,
      impulseSignalDir: p.impulseSignal?.dir || null
    });
  }

  const top = [...players.values()]
    .sort((a, b) => b.mass - a.mass)
    .slice(0, 10)
    .map((p, index) => ({ rank: index + 1, id: p.id, name: p.name, mass: Math.floor(p.mass) }));

  return {
    type: "state",
    t: Date.now(),
    world: { w: WORLD_W, h: WORLD_H },
    players: ps,
    foods,
    top
  };
}


function isAdminSocket(ws) {
  return wsMeta.get(ws)?.isAdmin === true;
}

function adminRosterRows() {
  const rows = [];
  for (const p of players.values()) {
    rows.push({ id: p.id, name: p.name, kind: p.kind || "player", mass: Math.floor(p.mass) });
  }
  return rows;
}

function sendAdminRoster(ws) {
  sendToSocket(ws, { type: "admin_roster", rows: adminRosterRows() });
}

function forceRemovePlayer(playerId, reason = "kicked") {
  const ws = playerSocketById.get(playerId);
  if (ws) {
    sockets.delete(ws);
    sendToSocket(ws, { type: "run_end", reason, earnedXp: 0, totalXp: 0 });
  }
  players.delete(playerId);
  playerSocketById.delete(playerId);
}

function handleAdminAction(ws, action, playerId) {
  if (!isAdminSocket(ws)) {
    sendToSocket(ws, { type: "admin_result", ok: false, message: "Action refusée." });
    return;
  }

  const player = players.get(playerId);
  if (!player) {
    sendToSocket(ws, { type: "admin_result", ok: false, message: "Cible introuvable." });
    return;
  }

  if (action === "kick") {
    forceRemovePlayer(playerId, "kicked_by_admin");
    sendToSocket(ws, { type: "admin_result", ok: true, message: `${player.name} expulsé.` });
    return;
  }

  if (action === "ban") {
    if (player.accountId) bannedAccounts.add(player.accountId);
    forceRemovePlayer(playerId, "banned_by_admin");
    sendToSocket(ws, { type: "admin_result", ok: true, message: `${player.name} banni.` });
    return;
  }

  if (action === "mass_down") {
    player.mass = Math.max(6, player.mass - 100);
    sendToSocket(ws, { type: "admin_result", ok: true, message: `${player.name} -100 masses.` });
    return;
  }

  if (action === "mass_up") {
    player.mass += 100;
    sendToSocket(ws, { type: "admin_result", ok: true, message: `${player.name} +100 masses.` });
    return;
  }

  sendToSocket(ws, { type: "admin_result", ok: false, message: "Action inconnue." });
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function removePlayerForSocket(ws, reason = "left") {
  const pid = sockets.get(ws);
  sockets.delete(ws);
  if (!pid) return;

  if (!pendingEliminations.has(pid)) {
    awardGlobalXpAndRemove(pid, reason);
  }
}

wss.on("connection", (ws) => {
  wsMeta.set(ws, { isAdmin: false, twitchId: "" });
  sendToSocket(ws, { type: "hello", msg: "stellumin-server" });
  sendToSocket(ws, statusForClient());
  sendToSocket(ws, snapshotForClient());

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "admin_auth") {
      const twitchId = typeof msg.twitchId === "string" ? msg.twitchId.slice(0, 64) : "";
      const isAdmin = twitchId === ADMIN_TWITCH_ID;
      wsMeta.set(ws, { isAdmin, twitchId });
      sendToSocket(ws, { type: "admin_status", enabled: isAdmin });
      return;
    }

    if (msg.type === "admin_roster") {
      if (!isAdminSocket(ws)) return;
      sendAdminRoster(ws);
      return;
    }

    if (msg.type === "admin_action") {
      const action = typeof msg.action === "string" ? msg.action : "";
      const playerId = typeof msg.playerId === "string" ? msg.playerId : "";
      handleAdminAction(ws, action, playerId);
      broadcast(statusForClient());
      return;
    }

    if (msg.type === "admin_add_bot") {
      if (!isAdminSocket(ws)) return;
      sendToSocket(ws, { type: "admin_result", ok: true, message: "Ajout bot bientôt disponible." });
      return;
    }

    if (msg.type === "progress_request") {
      const twitchId = typeof msg.twitchId === "string" ? msg.twitchId.slice(0, 64) : "";
      const name = typeof msg.name === "string" ? msg.name.slice(0, 20) : "";
      const avatar = typeof msg.avatar === "string" ? msg.avatar.slice(0, 400) : "";
      if (!twitchId) {
        sendToSocket(ws, { type: "progress", xp: 0 });
        return;
      }
      const progress = getOrCreateProgress(twitchId, name, avatar);
      if (name || avatar) {
        upsertProgress(twitchId, {
          xp: progress.xp,
          name: name || progress.name,
          avatar: avatar || progress.avatar
        });
      }
      sendToSocket(ws, { type: "progress", xp: progress.xp });
      return;
    }

    if (msg.type === "join") {
      if (sockets.has(ws)) return;
      if (players.size >= MAX_PLAYERS) {
        sendToSocket(ws, { type: "join_rejected", reason: "server_full", maxPlayers: MAX_PLAYERS });
        return;
      }

      const id = cryptoRandomId();
      const name = typeof msg.name === "string" ? msg.name.slice(0, 20) : "Player";
      const avatar = typeof msg.avatar === "string" ? msg.avatar.slice(0, 400) : "";
      const twitchId = typeof msg.twitchId === "string" ? msg.twitchId.slice(0, 64) : "";
      if (twitchId && bannedAccounts.has(twitchId)) {
        sendToSocket(ws, { type: "join_rejected", reason: "banned" });
        return;
      }
      const spawn = pickSpawnPoint();

      const p = {
        id,
        accountId: twitchId || id,
        name,
        avatar,
        x: spawn.x,
        y: spawn.y,
        vx: 0,
        vy: 0,
        mass: START_MASS,
        kind: "player",
        sessionMassGained: 0,
        input: { dx: 0, dy: 0, mag: 1 },
        impulseRecharge: [],
        pendingImpulses: [],
        impulseSignal: null
      };

      players.set(id, p);
      sockets.set(ws, id);
      playerSocketById.set(id, ws);

      upsertProgress(p.accountId, { name: p.name, avatar: p.avatar });

      sendToSocket(ws, { type: "joined", id, startMass: START_MASS });
      broadcast(statusForClient());
      return;
    }

    if (msg.type === "leave") {
      removePlayerForSocket(ws, "left");
      broadcast(statusForClient());
      return;
    }


    if (msg.type === "ability_use") {
      const pid = sockets.get(ws);
      if (!pid) return;
      const p = players.get(pid);
      if (!p) return;

      const { dx, dy } = normalizeDir(Number(msg.dx) || 0, Number(msg.dy) || 0);
      const ability = typeof msg.ability === "string" ? msg.ability : "";

      if (ability === "mass_eject") {
        castMassEject(p, { dx, dy });
      } else if (ability === "stellar_impulse") {
        castStellarImpulse(p, { dx, dy });
      }
      return;
    }

    if (msg.type === "input") {
      const pid = sockets.get(ws);
      if (!pid) return;
      const p = players.get(pid);
      if (!p) return;

      p.input.dx = clamp(Number(msg.dx) || 0, -1, 1);
      p.input.dy = clamp(Number(msg.dy) || 0, -1, 1);
      p.input.mag = clamp(Number(msg.mag), 0, 1);
      if (!Number.isFinite(p.input.mag)) p.input.mag = 1;
    }
  });

  ws.on("close", () => {
    removePlayerForSocket(ws, "left");
    wsMeta.delete(ws);
    broadcast(statusForClient());
  });
});

setInterval(() => {
  if (players.size === 0) {
    broadcast(statusForClient());
    return;
  }

  while (foods.length < FOOD_TARGET) foods.push(makeFood());

  for (const f of foods) {
    if (!f.vx && !f.vy) continue;
    f.vx *= EJECTED_DRAG;
    f.vy *= EJECTED_DRAG;
    if (Math.abs(f.vx) < 5) f.vx = 0;
    if (Math.abs(f.vy) < 5) f.vy = 0;
    f.x = clamp(f.x + f.vx * DT, -WORLD_W / 2, WORLD_W / 2);
    f.y = clamp(f.y + f.vy * DT, -WORLD_H / 2, WORLD_H / 2);
  }

  for (const p of players.values()) {
    resolvePendingImpulses(p);
    const sp = speedFromMass(p.mass);
    const moveFactor = clamp(Number(p.input.mag), 0, 1);
    p.vx = p.vx * DRAG + p.input.dx * sp * moveFactor * (1 - DRAG);
    p.vy = p.vy * DRAG + p.input.dy * sp * moveFactor * (1 - DRAG);

    p.x += p.vx * DT;
    p.y += p.vy * DT;

    p.x = clamp(p.x, -WORLD_W / 2, WORLD_W / 2);
    p.y = clamp(p.y, -WORLD_H / 2, WORLD_H / 2);

    const pr = radiusFromMass(p.mass);
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      if (dist2(p.x, p.y, f.x, f.y) <= (pr + f.r) * (pr + f.r)) {
        foods.splice(i, 1);
        p.mass += f.mass;
        if (f.grantSessionGain !== false) p.sessionMassGained += f.mass;
      }
    }
  }

  const deaths = new Set();
  const allPlayers = [...players.values()];
  for (let i = 0; i < allPlayers.length; i++) {
    const a = allPlayers[i];
    if (!players.has(a.id) || deaths.has(a.id)) continue;

    for (let j = i + 1; j < allPlayers.length; j++) {
      const b = allPlayers[j];
      if (!players.has(b.id) || deaths.has(b.id)) continue;

      const ar = radiusFromMass(a.mass);
      const br = radiusFromMass(b.mass);
      const d2 = dist2(a.x, a.y, b.x, b.y);
      const eatDistance = Math.max(ar, br) * 0.8;

      if (d2 > eatDistance * eatDistance) continue;

      if (a.mass > b.mass * 1.12) {
        a.mass += b.mass * 0.9;
        a.sessionMassGained += b.mass * 0.75;
        deaths.add(b.id);
      } else if (b.mass > a.mass * 1.12) {
        b.mass += a.mass * 0.9;
        b.sessionMassGained += a.mass * 0.75;
        deaths.add(a.id);
      }
    }
  }

  for (const id of deaths) {
    scheduleEliminationRunEnd(id, "eaten", 5000);
  }

  broadcast(statusForClient());
  broadcast(snapshotForClient());
}, 1000 / TICK_HZ);

await loadProgress();
console.log(`Stellumin.io server listening on :${PORT}`);
