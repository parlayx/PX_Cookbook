/* Browser client. Connects to the local relay, applies snapshot then delta
   frames into a local book per market, and redraws the ladder and depth chart.
   This is the same frame handling a customer writes against the live service;
   the only difference is the relay sits in front so the API key stays server
   side. */

const LEVELS = 10; /* levels shown per side */

const panelsEl = document.getElementById("panels");
const modeEl = document.getElementById("mode");
const connEl = document.getElementById("conn");
const rateEl = document.getElementById("rate");

/* Mirror of config.mjs marketKey so the browser routes frames to panels. */
function marketKey(stream) {
  if (stream.venue === "limitless") return `limitless:${stream.marketKey}:${stream.outcomeId}`;
  return `${stream.venue}:${stream.outcomeId}`;
}

const panels = new Map(); /* marketKey -> panel state */
const subToKey = new Map(); /* subscriptionId -> marketKey */
let frameCount = 0;

function createPanel(market) {
  const key = marketKey(market.stream);
  const root = document.createElement("section");
  root.className = "panel";
  root.innerHTML = `
    <div class="panel-head">
      <span class="label">${market.label}</span>
      <span class="venue">${market.stream.venue}</span>
      <span class="state" data-state="pending">pending</span>
    </div>
    <div class="ladder asks"></div>
    <div class="mid"><span class="spread"></span><span class="midprice"></span></div>
    <div class="ladder bids"></div>
    <canvas class="depth" height="90"></canvas>
  `;
  panelsEl.appendChild(root);
  const panel = {
    key,
    bids: new Map(),
    asks: new Map(),
    changed: new Set(),
    el: { root, asks: root.querySelector(".asks"), bids: root.querySelector(".bids"),
          spread: root.querySelector(".spread"), mid: root.querySelector(".midprice"),
          state: root.querySelector(".state"), depth: root.querySelector(".depth") },
  };
  panels.set(key, panel);
  return panel;
}

function rows(book, side, descending) {
  const sorted = [...book.entries()].sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return sorted.slice(0, LEVELS).reverse(); /* nearest the spread rendered closest to mid */
}

function renderLadder(el, levels, side, maxSize, changed) {
  el.innerHTML = levels
    .map(([price, size]) => {
      const width = maxSize > 0 ? Math.round((size / maxSize) * 100) : 0;
      const flash = changed.has(price) ? " flash" : "";
      return `<div class="row ${side}${flash}">
        <span class="bar" style="width:${width}%"></span>
        <span class="price">${price.toFixed(3)}</span>
        <span class="size">${size.toLocaleString()}</span>
      </div>`;
    })
    .join("");
}

function drawDepth(panel) {
  const canvas = panel.el.depth;
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = canvas.clientWidth);
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (panel.bids.size === 0 && panel.asks.size === 0) return;

  const bids = [...panel.bids.entries()].sort((a, b) => b[0] - a[0]);
  const asks = [...panel.asks.entries()].sort((a, b) => a[0] - b[0]);
  let cumBid = 0;
  const bidPts = bids.map(([p, s]) => [p, (cumBid += s)]);
  let cumAsk = 0;
  const askPts = asks.map(([p, s]) => [p, (cumAsk += s)]);
  const maxCum = Math.max(cumBid, cumAsk, 1);
  const prices = [...bidPts, ...askPts].map(([p]) => p);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const span = maxP - minP || 1;
  const x = (p) => ((p - minP) / span) * w;
  const y = (c) => h - (c / maxCum) * h;

  const area = (pts, color) => {
    if (pts.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(x(pts[0][0]), h);
    for (const [p, c] of pts) ctx.lineTo(x(p), y(c));
    ctx.lineTo(x(pts[pts.length - 1][0]), h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  area(bidPts, "rgba(46, 204, 113, 0.35)");
  area(askPts, "rgba(231, 76, 60, 0.35)");
}

function render(panel) {
  const allSizes = [...panel.bids.values(), ...panel.asks.values()];
  const maxSize = allSizes.length ? Math.max(...allSizes) : 0;
  renderLadder(panel.el.asks, rows(panel.asks, "ask", false), "ask", maxSize, panel.changed);
  renderLadder(panel.el.bids, rows(panel.bids, "bid", true), "bid", maxSize, panel.changed);

  const bestBid = panel.bids.size ? Math.max(...panel.bids.keys()) : null;
  const bestAsk = panel.asks.size ? Math.min(...panel.asks.keys()) : null;
  if (bestBid !== null && bestAsk !== null) {
    panel.el.spread.textContent = `spread ${(bestAsk - bestBid).toFixed(3)}`;
    panel.el.mid.textContent = `mid ${((bestAsk + bestBid) / 2).toFixed(3)}`;
  } else {
    panel.el.spread.textContent = "";
    panel.el.mid.textContent = "";
  }
  drawDepth(panel);
  panel.changed.clear();
}

function handleFrame(frame) {
  frameCount += 1;
  switch (frame.type) {
    case "hello":
      modeEl.textContent = "live";
      panelsEl.innerHTML = "";
      panels.clear();
      subToKey.clear();
      for (const market of frame.markets) createPanel(market);
      break;
    case "subscribed": {
      const key = marketKey(frame.market);
      subToKey.set(frame.subscriptionId, key);
      const panel = panels.get(key);
      if (panel) panel.el.state.dataset.state = "live";
      break;
    }
    case "snapshot": {
      const panel = panels.get(subToKey.get(frame.subscriptionId));
      if (!panel) break;
      panel.bids = new Map(frame.bids.map((l) => [l.price, l.size]));
      panel.asks = new Map(frame.asks.map((l) => [l.price, l.size]));
      panel.changed.clear();
      render(panel);
      break;
    }
    case "delta": {
      const panel = panels.get(subToKey.get(frame.subscriptionId));
      if (!panel) break;
      for (const change of frame.changes) {
        const book = change.side === "bid" ? panel.bids : panel.asks;
        if (change.size === 0) book.delete(change.price);
        else book.set(change.price, change.size);
        panel.changed.add(change.price);
      }
      render(panel);
      break;
    }
    case "status": {
      const panel = panels.get(subToKey.get(frame.subscriptionId));
      if (panel) panel.el.state.dataset.state = frame.state;
      break;
    }
  }
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => connEl.classList.add("on");
  ws.onclose = () => {
    connEl.classList.remove("on");
    setTimeout(connect, 1500);
  };
  ws.onmessage = (event) => handleFrame(JSON.parse(event.data));
}

setInterval(() => {
  rateEl.textContent = `${frameCount} frames/s`;
  frameCount = 0;
}, 1000);

connect();
