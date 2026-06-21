// Headless 2-player smoke test of the game loop. Run: node test.js
const { spawn } = require("child_process");
const { io } = require("socket.io-client");
const fs = require("fs");

const ITEMS = JSON.parse(fs.readFileSync("items.json", "utf-8"));
const nameById = Object.fromEntries(ITEMS.map((i) => [i.id, i.name]));
const URL = "http://localhost:3011";

const srv = spawn("node", ["server.js"], { env: { ...process.env, PORT: "3011" }, stdio: "inherit" });
const log = (...a) => console.log("  ", ...a);
const fail = (m) => { console.error("FAIL:", m); srv.kill(); process.exit(1); };

setTimeout(run, 1200);

function run() {
  const host = io(URL), guest = io(URL);
  let code = null, gotCorrect = false, gotReveal = false, gotOver = false;

  host.on("connect", () => host.emit("create", { name: "Host" }));
  host.on("joined", (d) => {
    code = d.code; log("host created room", code);
    host.emit("settings", { rounds: 1, roundTime: 10 });
    guest.emit("join", { code, name: "Guest" });
  });

  let started = false;
  host.on("state", (s) => {
    if (s.players.length === 2 && !started) {
      started = true; log("2 players in lobby -> start"); host.emit("start");
    }
  });

  let maskOk = false;
  const onRound = (who) => (r) => {
    const answer = nameById[r.itemId];
    if (who === "host") {
      const letters = (r.mask || []).filter((m) => m === null).length;
      maskOk = Array.isArray(r.mask) && letters > 0;
      log(`mask len=${r.mask ? r.mask.length : "?"} hidden letters=${letters} (${maskOk ? "ok" : "BAD"})`);
    }
    log(`${who} sees round ${r.round}, item=${r.itemId} (${answer})`);
    // guess correctly after a short beat
    setTimeout(() => (who === "host" ? host : guest).emit("guess", answer), 300);
  };
  host.on("round", onRound("host"));
  guest.on("round", onRound("guest"));

  host.on("correct", (c) => { gotCorrect = true; log(`correct by ${c.name} +${c.pts}`); });
  host.on("reveal", (rv) => { gotReveal = true; log("reveal:", rv.name, "| scores:", rv.players.map((p) => `${p.name}=${p.score}`).join(", ")); });
  host.on("gameover", (g) => {
    gotOver = true;
    log("gameover winner:", g.players[0].name, g.players[0].score);
    setTimeout(() => {
      const pass = gotCorrect && gotReveal && gotOver && g.players[0].score > 0 && maskOk;
      console.log(pass ? "\nPASS ✅ full game loop works" : "\nFAIL ❌");
      srv.kill(); process.exit(pass ? 0 : 1);
    }, 200);
  });

  host.on("connect_error", (e) => fail("connect " + e.message));
  setTimeout(() => fail("timed out (no gameover)"), 9000);
}
