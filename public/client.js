/* OSRS Item-Zoom client. Server is authoritative; we only render. */
const socket = io();
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

let me = { id: null, host: false };
let zoomAnim = null;
let cdTimer = null;
let maskTiles = [];
let curIcon = "";   // current round's icon url (kept for the reveal overlay)
const ZOOM_BASE = 60;  // % of box the sprite fills at scale 1 (matches old img sizing)
const MAX_ZOOM = 8, MIN_ZOOM = 1.1;
const ZOOM_EASE = 3.4;   // >1 = blow past the extreme zoom fast, linger on the readable range

// ── connection status (so buttons are never a silent dead-end) ──
function setConn(connected, msg) {
  $("createBtn").disabled = !connected;
  $("joinBtn").disabled = !connected;
  if (msg !== undefined) $("homeErr").textContent = msg;
}
// remember the player's name across visits; name is required (no silent guest)
const savedName = localStorage.getItem("rz_name") || "";
if (savedName) $("name").value = savedName;
function getName() {
  const n = $("name").value.trim();
  if (!n) { $("homeErr").textContent = "Enter a name first ↑"; $("name").focus(); return null; }
  localStorage.setItem("rz_name", n);
  return n;
}

// arriving via ?room=XXXX: prefill the code and prompt for a name (don't auto-join)
const qp = (new URLSearchParams(location.search).get("room") || "").toUpperCase();
const joinPrompt = () => (qp ? `Enter your name to join room ${qp} ↑` : "");
if (qp) { $("codeIn").value = qp; setTimeout(() => $("name").focus(), 50); }

setConn(false, "Connecting to server…");
socket.on("connect", () => { me.id = socket.id; setConn(true, joinPrompt()); if (qp) $("name").focus(); });
socket.on("disconnect", () => setConn(false, "Lost connection — reconnecting…"));
socket.on("connect_error", () =>
  setConn(false, "Waking the server… first visit can take ~30–50s, hang tight."));
socket.io.on("reconnect_attempt", () =>
  setConn(false, "Waking the server… first visit can take ~30–50s, hang tight."));

// ── home ──
$("createBtn").onclick = () => {
  const n = getName(); if (!n) return;
  if (!socket.connected) return setConn(false, "Not connected yet — one sec…");
  socket.emit("create", { name: n });
};
$("joinBtn").onclick = () => {
  const n = getName(); if (!n) return;
  if (!socket.connected) return setConn(false, "Not connected yet — one sec…");
  socket.emit("join", { code: $("codeIn").value, name: n });
};
$("codeIn").addEventListener("keydown", (e) => { if (e.key === "Enter") $("joinBtn").click(); });
$("name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") ($("codeIn").value.trim() ? $("joinBtn") : $("createBtn")).click();
});

socket.on("errorMsg", (m) => ($("homeErr").textContent = m));

socket.on("joined", ({ code }) => {
  hide("home"); show("lobby"); hide("game"); hide("overlay");
  $("lobbyCode").textContent = code;
  history.replaceState(null, "", `?room=${code}`);
});

// ── lobby / scores ──
function renderPlayers(ul, players, opts = {}) {
  ul.innerHTML = "";
  for (const p of players) {
    const li = document.createElement("li");
    const tag = document.createElement("span");
    tag.textContent = p.name;
    if (p.id === me.id) tag.classList.add("you");
    if (p.host) tag.classList.add("crown");
    li.appendChild(tag);
    if (opts.pts) {
      const pts = document.createElement("span");
      pts.className = "pts" + (p.guessed ? " done" : "");
      pts.textContent = p.score;
      li.appendChild(pts);
    } else if (opts.ready) {
      const r = document.createElement("span");
      r.className = "readytag " + (p.ready ? "is" : "no");
      r.textContent = p.ready ? "READY ✓" : "not ready";
      li.appendChild(r);
    }
    ul.appendChild(li);
  }
}

socket.on("state", (s) => {
  const meP = s.players.find((p) => p.id === me.id) || {};
  me.host = !!meP.host;
  renderPlayers($("lobbyPlayers"), s.players, { ready: true });
  renderPlayers($("scores"), s.players, { pts: true });
  $("hostControls").classList.toggle("hidden", !me.host);
  $("waitHost").classList.toggle("hidden", me.host);
  // reflect my own ready state on the button
  $("readyBtn").textContent = meP.ready ? "READY ✓ — click to unready" : "I'M READY";
  $("readyBtn").classList.toggle("green", !!meP.ready);
  // reflect the chosen reveal mode for everyone
  if (s.mode) {
    $("setMode").value = s.mode;
    $("modeNote").textContent = "Mode: " + (s.mode === "scratch" ? "Scratch card" : "Zoom out");
  }
});

$("readyBtn").onclick = () => socket.emit("toggleReady");

$("copyLink").onclick = async () => {
  const url = location.href; // includes ?room=CODE
  try {
    await navigator.clipboard.writeText(url);
    $("copyLink").textContent = "LINK COPIED ✓";
  } catch {
    prompt("Copy this lobby link:", url);
    $("copyLink").textContent = "📋 COPY LOBBY LINK";
    return;
  }
  setTimeout(() => ($("copyLink").textContent = "📋 COPY LOBBY LINK"), 1500);
};

// ── lobby chat ──
$("lobbyChatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("lobbyChatIn").value.trim();
  if (!v) return;
  socket.emit("lobbyChat", v);
  $("lobbyChatIn").value = "";
});
socket.on("lobbyMsg", ({ name, text }) => {
  const li = document.createElement("li");
  li.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
  const c = $("lobbyChatList");
  c.appendChild(li);
  c.scrollTop = c.scrollHeight;
});

$("setRounds").onchange = $("setTime").onchange = $("setMode").onchange = () =>
  socket.emit("settings", {
    rounds: $("setRounds").value, roundTime: $("setTime").value, mode: $("setMode").value,
  });
$("startBtn").onclick = () => socket.emit("start");

// ── round: reveal animation (zoom-out OR scratch-card) ──
socket.on("round", ({ round, totalRounds, itemId, roundTime, mask, mode }) => {
  hide("lobby"); hide("overlay"); show("game");
  clearInterval(cdTimer);
  $("roundLabel").textContent = `Round ${round}/${totalRounds}`;
  $("statusLine").textContent = "Type your guess ↓";
  $("statusLine").classList.remove("good");
  $("guessIn").disabled = false;
  $("guessIn").value = "";
  $("guessIn").focus();
  $("chat").innerHTML = "";
  renderMask(mask);

  // render as a CSS background (no draggable / right-click-saveable <img> to cheat with)
  curIcon = `icons/${itemId}.png`;
  const box = $("zoombox");
  box.style.backgroundImage = `url("${curIcon}")`;

  const scratchMode = mode === "scratch";
  let tiles = [];
  if (scratchMode) {
    box.style.backgroundSize = "contain";   // full sprite, hidden behind tiles
    tiles = buildScratch();
    show("scratch");
  } else {
    hide("scratch");
    $("scratch").innerHTML = "";
  }

  const start = performance.now();
  const durMs = roundTime * 1000;
  cancelAnimationFrame(zoomAnim);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / durMs);
    if (scratchMode) {
      // peel tiles away over the round (fast early, slow late) to reveal the sprite
      const eased = 1 - Math.pow(1 - t, ZOOM_EASE);
      const reveal = Math.floor(eased * tiles.length);
      for (let k = 0; k < reveal; k++) tiles[k].classList.add("gone");
    } else {
      const eased = 1 - Math.pow(1 - t, ZOOM_EASE); // fast early, slow late
      const scale = MAX_ZOOM - (MAX_ZOOM - MIN_ZOOM) * eased;
      box.style.backgroundSize = `${(ZOOM_BASE * scale).toFixed(1)}%`;
    }
    $("timer").textContent = Math.ceil(roundTime - t * roundTime);
    if (t < 1) zoomAnim = requestAnimationFrame(tick);
  };
  zoomAnim = requestAnimationFrame(tick);
});

// build a shuffled grid of opaque tiles over the sprite (scratch-card reveal)
function buildScratch() {
  const s = $("scratch");
  s.innerHTML = "";
  const N = 12 * 12;
  const tiles = [];
  for (let i = 0; i < N; i++) {
    const d = document.createElement("div");
    d.className = "stile";
    s.appendChild(d);
    tiles.push(d);
  }
  for (let i = tiles.length - 1; i > 0; i--) { // shuffle reveal order
    const j = (Math.random() * (i + 1)) | 0;
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles;
}

// ── hangman mask ──
function renderMask(mask) {
  const box = $("mask");
  box.innerHTML = "";
  maskTiles = [];
  let word = null;
  const newWord = () => { word = document.createElement("div"); word.className = "word"; box.appendChild(word); };
  newWord();
  (mask || []).forEach((ch, i) => {
    if (ch !== null && /\s/.test(ch)) { maskTiles[i] = null; newWord(); return; } // whole-word break
    const el = document.createElement("span");
    if (ch === null) { el.className = "tile"; el.textContent = ""; }       // hidden letter
    else { el.className = "tile filled"; el.textContent = ch; }            // shown punctuation
    word.appendChild(el);
    maskTiles[i] = el;
  });
}
socket.on("hint", ({ i, c }) => {
  const tile = maskTiles[i];
  if (tile) { tile.textContent = c; tile.classList.add("filled"); }
});

// ── guessing ──
$("guessForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("guessIn").value.trim();
  if (!v) return;
  socket.emit("guess", v);
  $("guessIn").value = "";
});

function chatLine(html, cls) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.innerHTML = html;
  const c = $("chat");
  c.appendChild(li);
  c.scrollTop = c.scrollHeight;
}
socket.on("chat", ({ name, text }) =>
  chatLine(`<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`));
socket.on("correct", ({ id, name, pts }) => {
  chatLine(`✅ ${escapeHtml(name)} guessed it! +${pts}`, "sys");
  if (id === me.id) {
    $("statusLine").textContent = `Correct! +${pts}`;
    $("statusLine").classList.add("good");
    $("guessIn").disabled = true;
  }
});

// ── reveal ──
socket.on("reveal", ({ name, tier, vol, players, nextIn }) => {
  cancelAnimationFrame(zoomAnim);
  hide("scratch");
  $("ovTitle").textContent = "IT WAS…";
  $("ovImg").src = curIcon;
  $("ovImg").classList.remove("hidden");
  $("ovName").textContent = name;
  $("ovMeta").textContent = `${tier.toUpperCase()} • ${vol.toLocaleString()} traded/day`;
  renderPlayers($("ovScores"), players, true);
  hide("ovHome"); show("overlay");

  clearInterval(cdTimer);
  let n = nextIn || 0;
  const tick = () => {
    $("ovCountdown").textContent = n > 0 ? `Next round in ${n}…` : "";
    if (n <= 0) clearInterval(cdTimer);
    n--;
  };
  tick();
  if (nextIn > 0) cdTimer = setInterval(tick, 1000);
});

// ── gameover ──
socket.on("gameover", ({ players }) => {
  clearInterval(cdTimer);
  $("ovCountdown").textContent = "";
  const win = players[0];
  $("ovTitle").textContent = "🏆 WINNER";
  $("ovImg").classList.add("hidden");
  $("ovName").textContent = win ? win.name : "—";
  $("ovMeta").textContent = win ? `${win.score} points` : "";
  renderPlayers($("ovScores"), players, true);
  show("overlay"); show("ovHome");
});
$("ovHome").onclick = () => location.href = location.pathname;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
