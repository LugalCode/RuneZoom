// OSRS Item-Zoom — multiplayer guessing game (skribbl-style)
// Authoritative server: owns the item, the timer and the scoring.
// Clients only ever receive a numeric icon id (no names) -> casual anti-cheat.

const path = require("path");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const ITEMS = JSON.parse(fs.readFileSync(path.join(__dirname, "items.json"), "utf-8"));
const PORT = process.env.PORT || 3000;

const HINT_EVERY = 7000;   // ms between free hangman-style letter reveals
const REVEAL_GAP = 6;      // seconds shown between rounds (countdown)

// ── helpers ──────────────────────────────────────────────────────────
const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, ""); // loose match: case/space/punct-insensitive

const roomCode = () => {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c;
  do { c = Array.from({ length: 4 }, () => A[(Math.random() * A.length) | 0]).join(""); }
  while (rooms[c]);
  return c;
};

const pickItems = (n) => {
  const pool = [...ITEMS];
  for (let i = pool.length - 1; i > 0; i--) { // shuffle
    const j = (Math.random() * (i + 1)) | 0;
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
};

const rooms = {}; // code -> room

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id, name: p.name, score: p.score, guessed: !!p.guessed, host: id === room.hostId,
  })).sort((a, b) => b.score - a.score);
}

function sendState(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("state", {
    code, phase: room.phase, round: room.round, totalRounds: room.settings.rounds,
    players: publicPlayers(room),
  });
}

function startRound(code) {
  const room = rooms[code];
  if (!room) return;
  room.round += 1;
  if (room.round > room.settings.rounds) return endGame(code);

  room.item = room.order[room.round - 1];
  room.phase = "playing";
  room.roundStart = Date.now();
  room.roundEndsAt = room.roundStart + room.settings.roundTime * 1000;
  room.correctCount = 0;
  for (const p of Object.values(room.players)) p.guessed = false;

  // hangman-style mask: letters/digits hidden (null), everything else shown
  const name = room.item.name;
  room.mask = [...name].map((ch) => (/[a-z0-9]/i.test(ch) ? null : ch));
  room.hiddenIdx = room.mask.map((m, i) => (m === null ? i : -1)).filter((i) => i >= 0);
  room.revealedIdx = [];

  sendState(code);
  io.to(code).emit("round", {
    round: room.round, totalRounds: room.settings.rounds,
    itemId: room.item.id, roundTime: room.settings.roundTime, mask: room.mask,
  });

  // free letter reveals on a timer; always leave ~30% hidden to guess
  clearInterval(room.hintTimer);
  const keepHidden = Math.max(1, Math.ceil(room.hiddenIdx.length * 0.30));
  room.hintTimer = setInterval(() => {
    if (room.phase !== "playing") return clearInterval(room.hintTimer);
    const remaining = room.hiddenIdx.filter((i) => !room.revealedIdx.includes(i));
    if (remaining.length <= keepHidden) return;
    const pick = remaining[(Math.random() * remaining.length) | 0];
    room.revealedIdx.push(pick);
    io.to(code).emit("hint", { i: pick, c: name[pick] });
  }, HINT_EVERY);

  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(code), room.settings.roundTime * 1000);
}

function endRound(code) {
  const room = rooms[code];
  if (!room || room.phase !== "playing") return;
  clearTimeout(room.timer);
  clearInterval(room.hintTimer);
  room.phase = "reveal";
  const last = room.round >= room.settings.rounds;
  io.to(code).emit("reveal", {
    name: room.item.name, tier: room.item.tier, vol: room.item.vol,
    players: publicPlayers(room), nextIn: last ? 0 : REVEAL_GAP,
  });
  room.timer = setTimeout(() => {
    if (last) endGame(code);
    else startRound(code);
  }, REVEAL_GAP * 1000);
}

function endGame(code) {
  const room = rooms[code];
  if (!room) return;
  clearTimeout(room.timer);
  clearInterval(room.hintTimer);
  room.phase = "ended";
  io.to(code).emit("gameover", { players: publicPlayers(room) });
  sendState(code);
}

// ── socket events ────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let code = null;

  const join = (c, name) => {
    code = c;
    socket.join(c);
    rooms[c].players[socket.id] = { name: (name || "Guest").slice(0, 16), score: 0, guessed: false };
    socket.emit("joined", { code: c });
    sendState(c);
  };

  socket.on("create", ({ name }) => {
    const c = roomCode();
    rooms[c] = {
      code: c, hostId: socket.id, players: {}, phase: "lobby", round: 0,
      settings: { rounds: 5, roundTime: 30 }, item: null, order: [], timer: null,
    };
    join(c, name);
  });

  socket.on("join", ({ code: c, name }) => {
    c = (c || "").toUpperCase();
    if (!rooms[c]) return socket.emit("errorMsg", "Room not found.");
    if (rooms[c].phase !== "lobby") return socket.emit("errorMsg", "Game already started.");
    join(c, name);
  });

  socket.on("settings", (s) => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId || room.phase !== "lobby") return;
    room.settings.rounds = Math.min(20, Math.max(1, parseInt(s.rounds) || 5));
    room.settings.roundTime = Math.min(60, Math.max(10, parseInt(s.roundTime) || 30));
    sendState(code);
  });

  socket.on("start", () => {
    const room = rooms[code];
    if (!room || socket.id !== room.hostId || room.phase === "playing") return;
    room.order = pickItems(room.settings.rounds);
    room.round = 0;
    for (const p of Object.values(room.players)) p.score = 0;
    startRound(code);
  });

  socket.on("guess", (text) => {
    const room = rooms[code];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    text = (text || "").toString().slice(0, 40);

    if (room.phase === "playing" && !p.guessed && norm(text) === norm(room.item.name)) {
      // correct — score by speed
      const left = Math.max(0, room.roundEndsAt - Date.now());
      const frac = left / (room.settings.roundTime * 1000);
      const order = room.correctCount++;          // 0 = first to guess
      const pts = Math.round(100 * frac) + Math.max(0, 50 - order * 10);
      p.score += pts;
      p.guessed = true;
      io.to(code).emit("correct", { id: socket.id, name: p.name, pts });
      sendState(code);
      // everyone (besides host-less check) guessed -> end early
      const active = Object.values(room.players);
      if (active.length && active.every((pl) => pl.guessed)) endRound(code);
    } else {
      // normal chat / wrong guess — never echo the actual answer
      const isAnswer = norm(text) === norm(room.item?.name || "");
      io.to(code).emit("chat", { name: p.name, text: isAnswer ? "🤫 (almost!)" : text });
    }
  });

  socket.on("disconnect", () => {
    const room = rooms[code];
    if (!room) return;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.timer);
      clearInterval(room.hintTimer);
      delete rooms[code];
      return;
    }
    if (socket.id === room.hostId) room.hostId = Object.keys(room.players)[0];
    sendState(code);
  });
});

server.listen(PORT, () => console.log(`OSRS Item-Zoom on :${PORT}  (${ITEMS.length} items)`));
