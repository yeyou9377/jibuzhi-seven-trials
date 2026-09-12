const SIZE = 9;
const MAX_ROUNDS = 10;
const DIRS = {
  up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1], stay: [0, 0],
};
const DIR_LABEL = { up: "北", down: "南", left: "西", right: "东", stay: "原地" };

const state = {
  map: [], player: { r: 7, c: 1 }, companion: { r: 1, c: 7 },
  playerTrail: new Set(), companionTrail: new Set(), round: 1,
  eye: "silver", previousDistance: null,
  shadowSeen: false, ended: false, rng: mulberry32(Date.now() >>> 0),
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function switchScreen(id) {
  $$(".screen").forEach((screen) => {
    const active = screen.id === id;
    screen.classList.toggle("active", active);
    screen.setAttribute("aria-hidden", String(!active));
  });
}

function key(pos) { return `${pos.r},${pos.c}`; }
function distance(a, b) { return Math.abs(a.r - b.r) + Math.abs(a.c - b.c); }
function inside(r, c) { return r >= 0 && c >= 0 && r < SIZE && c < SIZE; }
function walkable(r, c) { return inside(r, c) && state.map[r][c] === 0; }

function connected(map) {
  const open = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!map[r][c]) open.push({ r, c });
  const seen = new Set([key(open[0])]);
  const queue = [open[0]];
  while (queue.length) {
    const p = queue.shift();
    Object.values(DIRS).slice(0, 4).forEach(([dr, dc]) => {
      const n = { r: p.r + dr, c: p.c + dc };
      if (inside(n.r, n.c) && !map[n.r][n.c] && !seen.has(key(n))) { seen.add(key(n)); queue.push(n); }
    });
  }
  return seen.size === open.length;
}

function generateMap() {
  let map;
  do {
    map = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
      if (state.rng() < .19) map[r][c] = 1;
    }
    map[7][1] = map[1][7] = 0;
  } while (!connected(map));
  state.map = map;
}

function distanceLevel(d) {
  if (d >= 9) return "遥远";
  if (d >= 6) return "远";
  if (d >= 3) return "近";
  return "很近";
}

function directionFromPlayer() {
  const dr = state.companion.r - state.player.r;
  const dc = state.companion.c - state.player.c;
  const vertical = dr < 0 ? "北" : dr > 0 ? "南" : "";
  const horizontal = dc < 0 ? "西" : dc > 0 ? "东" : "";
  return vertical + horizontal || "脚下";
}

function visible(r, c) {
  const radius = state.eye === "gold" ? 2 : 1;
  return Math.abs(r - state.player.r) <= radius && Math.abs(c - state.player.c) <= radius;
}

function renderMap() {
  const map = $("#map");
  map.innerHTML = "";
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const tile = document.createElement("div");
    tile.className = `tile ${state.map[r][c] ? "wall" : "floor"}`;
    const isVisible = visible(r, c);
    if (!isVisible) tile.classList.add("fog");
    if (state.playerTrail.has(`${r},${c}`) && isVisible) tile.classList.add("trail");
    if (state.eye === "gold" && !isVisible && ((r * 11 + c * 7 + state.round) % 17 === 0)) tile.classList.add("false-shape");
    if (r === state.player.r && c === state.player.c) {
      const actor = document.createElement("div"); actor.className = "traveler"; tile.appendChild(actor);
    }
    if (distance(state.player, state.companion) <= 1 && r === state.companion.r && c === state.companion.c) {
      const actor = document.createElement("div"); actor.className = "companion"; tile.appendChild(actor);
    }
    map.appendChild(tile);
  }
}

function wallSense() {
  const labels = [];
  for (const name of ["up", "right", "down", "left"]) {
    const [dr, dc] = DIRS[name];
    if (!walkable(state.companion.r + dr, state.companion.c + dc)) labels.push(`${DIR_LABEL[name]}侧`);
  }
  return labels.length ? `${labels.join("、")}有阻碍` : "四周空旷";
}

function renderSense() {
  const d = distance(state.player, state.companion);
  const level = distanceLevel(d);
  $("#distance-text").textContent = level;
  $("#distance-badge").textContent = level;
  $("#walls-text").textContent = wallSense();
  if (state.previousDistance == null) $("#delta-text").textContent = "尚无";
  else $("#delta-text").textContent = d < state.previousDistance ? "靠近" : d > state.previousDistance ? "远离" : "不变";
  $("#round").textContent = state.round;
}

function say(text, type = "companion") {
  const line = document.createElement("div");
  line.className = `line ${type}`;
  line.textContent = text;
  $("#dialogue").appendChild(line);
  $("#dialogue").scrollTop = $("#dialogue").scrollHeight;
}

function parseHint(text) {
  if (/北|上/.test(text)) return "up";
  if (/南|下/.test(text)) return "down";
  if (/西|左/.test(text)) return "left";
  if (/东|右/.test(text)) return "right";
  if (/停|等|别动|原地/.test(text)) return "stay";
  return null;
}

function bestCompanionMove(message) {
  const hinted = parseHint(message);
  const candidates = Object.entries(DIRS).filter(([, [dr, dc]]) => walkable(state.companion.r + dr, state.companion.c + dc));
  if (hinted && candidates.some(([name]) => name === hinted) && state.rng() < .82) return hinted;
  const prior = state.companionTrail;
  const scored = candidates.map(([name, [dr, dc]]) => {
    const next = { r: state.companion.r + dr, c: state.companion.c + dc };
    let score = -distance(next, state.player) * 1.4;
    if (!prior.has(key(next))) score += 1.1;
    if (name === "stay") score -= distance(state.player, state.companion) <= 2 ? 0 : 2;
    score += state.rng() * 1.8;
    return { name, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0].name;
}

function move(pos, direction) {
  const [dr, dc] = DIRS[direction];
  const next = { r: pos.r + dr, c: pos.c + dc };
  return walkable(next.r, next.c) ? next : { ...pos };
}

function companionReply(oldDistance, newDistance, companionMove) {
  if (newDistance <= 1) return "我听见你的呼吸了。下一步，朝我走。";
  if (newDistance < oldDistance) return `近了一些。我刚才向${DIR_LABEL[companionMove]}走。`;
  if (newDistance > oldDistance) return "震动远了。我们中有一个人走反了，下一步我会修正。";
  const options = ["距离没有变化。也许墙替我们撒了谎。", "我还在。别急着相信庙里的回声。", "我摸到了一道旧石墙，正在绕过去。"]; 
  return options[Math.floor(state.rng() * options.length)];
}

function templeEcho(message) {
  if (state.round < 3 || state.rng() > .52) return;
  const echo = message ? message.replace(/我/g, "它").replace(/你/g, "我") : "我就在你身后。";
  say(`石壁学着你的声音说：“${echo}”`, "temple");
}

function templeBeat(round) {
  const beats = {
    2: "石阶深处亮起一只金色的眼。它看向错误的方向。",
    4: "墙缝里落下几颗决明子。每一颗，都发出与你脚步相反的回声。",
    6: "庙门问：若看见会欺骗你，你还愿意把方向告诉另一个人吗？",
    8: "银瞳缓慢合上。黑暗没有消失，但你开始分得清哪一次震动属于它。",
  };
  if (beats[round]) say(beats[round], "temple");
}

function pulseVibration() {
  const vibration = $("#vibration");
  const dr = Math.sign(state.companion.r - state.player.r);
  const dc = Math.sign(state.companion.c - state.player.c);
  vibration.style.setProperty("--vx", `${dc * 120}px`);
  vibration.style.setProperty("--vy", `${dr * 120}px`);
  vibration.classList.remove("pulse"); void vibration.offsetWidth; vibration.classList.add("pulse");
}

function finish(success) {
  state.ended = true;
  $("#ending-title").textContent = success ? "你们在黑暗里认出了彼此" : "神庙收走了最后一圈光";
  $("#ending-copy").textContent = success
    ? `第 ${state.round} 回合，你们同时走向了对方。决明子在石缝里发出银光。`
    : "十次震动已经过去。你仍听见另一个呼吸——神庙允许你们重新来过。";
  $("#name-place").hidden = !success;
  $("#place-name").parentElement?.classList.toggle("failed", !success);
  $("#restart").hidden = success;
  switchScreen("ending");
}

function commitTurn(direction) {
  if (!direction || state.ended) return;
  const message = $("#message").value.trim();
  const oldPlayer = { ...state.player }, oldCompanion = { ...state.companion };
  const oldDistance = distance(oldPlayer, oldCompanion);
  const companionMove = bestCompanionMove(message);
  const nextPlayer = move(oldPlayer, direction);
  const nextCompanion = move(oldCompanion, companionMove);
  const wasAdjacent = oldDistance === 1;
  const bothApproached = distance(nextPlayer, oldCompanion) < oldDistance && distance(nextCompanion, oldPlayer) < oldDistance;

  state.previousDistance = oldDistance;
  state.player = nextPlayer; state.companion = nextCompanion;
  state.playerTrail.add(key(state.player)); state.companionTrail.add(key(state.companion));
  const newDistance = distance(state.player, state.companion);
  if (message) say(message, "you");
  templeEcho(message);
  say(companionReply(oldDistance, newDistance, companionMove));
  templeBeat(state.round);

  if ((wasAdjacent && bothApproached) || newDistance === 0) { renderMap(); renderSense(); setTimeout(() => finish(true), 650); return; }
  state.shadowSeen = newDistance === 1;
  $("#shadow-message").classList.toggle("show", state.shadowSeen);
  pulseVibration();
  state.round += 1;
  if (state.round > MAX_ROUNDS) { setTimeout(() => finish(false), 500); return; }
  $$("[data-move]").forEach((b) => b.classList.remove("selected"));
  $("#message").value = "";
  renderMap(); renderSense();
}

function startGame(eye) {
  state.eye = eye; state.round = 1; state.ended = false;
  state.player = { r: 7, c: 1 }; state.companion = { r: 1, c: 7 };
  state.playerTrail = new Set([key(state.player)]); state.companionTrail = new Set([key(state.companion)]);
  state.previousDistance = null; state.rng = mulberry32((Date.now() ^ (eye === "gold" ? 9173 : 421)) >>> 0);
  generateMap();
  $("#dialogue").innerHTML = "";
  say(eye === "gold" ? "你的光很亮。我分不清哪些轮廓是真的。" : "你的光很安静。我能听见它没有撒谎。");
  say("我只能知道我们相隔多远，摸到身边的墙。你能告诉我方向吗？");
  renderMap(); renderSense(); switchScreen("game");
}

$("#enter-button").addEventListener("click", () => switchScreen("choice"));
$$('[data-eye]').forEach((button) => button.addEventListener("click", () => startGame(button.dataset.eye)));
$$('[data-move]').forEach((button) => button.addEventListener("click", () => {
  button.classList.add("selected");
  setTimeout(() => button.classList.remove("selected"), 180);
  commitTurn(button.dataset.move);
}));
$$('[data-message]').forEach((button) => button.addEventListener("click", () => { $("#message").value = button.dataset.message; }));
$("#name-place").addEventListener("click", () => {
  const name = $("#place-name").value.trim() || "无名之处";
  const keepsake = $("#keepsake");
  keepsake.hidden = false;
  keepsake.replaceChildren(
    document.createTextNode("你与无名灵伴在「"),
    Object.assign(document.createElement("strong"), { textContent: name }),
    document.createTextNode("」相遇。"),
    document.createElement("br"),
    document.createTextNode("你们从宝箱里取走第一味：决明子。"),
  );
  localStorage.setItem("qiwei.jueming.placeName", name);
  $("#name-place").hidden = true; $("#restart").hidden = false;
});
$("#restart").addEventListener("click", () => switchScreen("choice"));

document.addEventListener("keydown", (event) => {
  if (!$("#game").classList.contains("active") || event.target.matches("textarea, input")) return;
  const map = { ArrowUp:"up", w:"up", W:"up", ArrowDown:"down", s:"down", S:"down", ArrowLeft:"left", a:"left", A:"left", ArrowRight:"right", d:"right", D:"right", " ":"stay", Enter:"commit" };
  const action = map[event.key];
  if (!action) return;
  event.preventDefault();
  if (action !== "commit") document.querySelector(`[data-move="${action}"]`).click();
});
