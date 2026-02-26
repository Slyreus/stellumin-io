import { WebSocketServer } from "ws";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;

// Monde
const WORLD_W = 4000;
const WORLD_H = 4000;

// Nourriture
const FOOD_TARGET = 1200;
const FOOD_RADIUS = 6;
const FOOD_MASS = 1;

// Joueurs
const BASE_RADIUS = 18;
const SPEED = 360; // unités/s (sera ralenti par la masse)
const DRAG = 0.92;

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
  return {
    id: cryptoRandomId(),
    x: rand(-WORLD_W / 2, WORLD_W / 2),
    y: rand(-WORLD_H / 2, WORLD_H / 2),
    r: FOOD_RADIUS
  };
}

function cryptoRandomId() {
  // fallback sans crypto web (node ok)
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const wss = new WebSocketServer({ port: PORT });

/**
 * players: id -> {
 *   id, name, avatar, x,y, vx,vy, mass, xp, input {dx,dy}
 * }
 */
const players = new Map();
const sockets = new Map(); // ws -> playerId

let foods = [];
for (let i = 0; i < FOOD_TARGET; i++) foods.push(makeFood());

function snapshotForClient() {
  // Snapshot volontairement simple (pas opti)
  const ps = [];
  for (const p of players.values()) {
    ps.push({
      id: p.id,
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

      const p = {
        id,
        name,
        avatar,
        x: rand(-500, 500),
        y: rand(-500, 500),
        vx: 0,
        vy: 0,
        mass: 10,
        xp: 0,
        input: { dx: 0, dy: 0 }
      };

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
    if (pid) players.delete(pid);
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
    const pr2 = pr * pr;
    for (let i = foods.length - 1; i >= 0; i--) {
      const f = foods[i];
      if (dist2(p.x, p.y, f.x, f.y) <= (pr + f.r) * (pr + f.r)) {
        foods.splice(i, 1);
        p.mass += FOOD_MASS;
        p.xp += FOOD_MASS; // XP = masse ramassée
      }
    }
  }

  broadcast({ type: "state", ...snapshotForClient() });
}, 1000 / TICK_HZ);

console.log(`Stellumin.io server listening on :${PORT}`);
