/* Orderbook depth visualizer server.

   Holds one connection to the stream service, keeps the authoritative book per
   subscription, and relays the same v1 frames out to every connected browser
   over a local WebSocket. A browser that connects late gets the current book
   replayed as a snapshot, then live deltas. */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { MARKETS } from "./config.mjs";
import { startLiveFeed } from "./live-feed.mjs";

try {
  process.loadEnvFile(".env");
} catch {}

const PORT = Number(process.env.PORT || 8080);
const STREAM_URL = process.env.PARX_STREAM_URL || "wss://wss.parlayx.com/v1/orderbook";
const STREAM_KEY = process.env.PARX_STREAM_KEY || "";

if (!STREAM_KEY) {
  console.error("Set PARX_STREAM_KEY in .env (copy .env.example to .env).");
  process.exit(1);
}

const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const books = new Map(); /* subscriptionId -> { market, bids: Map, asks: Map, seq } */
const subscribedFrames = new Map(); /* subscriptionId -> the subscribed frame, for replay */
const clients = new Set();

function applyFrame(frame) {
  switch (frame.type) {
    case "subscribed":
      subscribedFrames.set(frame.subscriptionId, frame);
      books.set(frame.subscriptionId, { market: frame.market, bids: new Map(), asks: new Map(), seq: 0 });
      break;
    case "snapshot": {
      const book = books.get(frame.subscriptionId);
      if (book) {
        book.bids = new Map(frame.bids.map((l) => [l.price, l.size]));
        book.asks = new Map(frame.asks.map((l) => [l.price, l.size]));
        book.seq = frame.seq;
      }
      break;
    }
    case "delta": {
      const book = books.get(frame.subscriptionId);
      if (book) {
        for (const change of frame.changes) {
          const side = change.side === "bid" ? book.bids : book.asks;
          if (change.size === 0) side.delete(change.price);
          else side.set(change.price, change.size);
        }
        book.seq = frame.seq;
      }
      break;
    }
  }
  broadcast(frame);
}

function broadcast(frame) {
  const text = JSON.stringify(frame);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(text);
  }
}

function snapshotFromBook(subscriptionId, book) {
  return {
    type: "snapshot",
    v: 1,
    serverTimestamp: Date.now(),
    subscriptionId,
    seq: book.seq,
    venueTimestamp: Date.now(),
    bids: [...book.bids].map(([price, size]) => ({ price, size })),
    asks: [...book.asks].map(([price, size]) => ({ price, size })),
    status: "live",
  };
}

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : decodeURIComponent(new URL(req.url, "http://x").pathname);
  const filePath = normalize(join(PUBLIC_DIR, path));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket) => {
  clients.add(socket);
  socket.on("close", () => clients.delete(socket));

  /* Bring the new browser up to the current state: the market list it should
     lay out, then each active subscription and its book so far. */
  socket.send(JSON.stringify({ type: "hello", markets: MARKETS }));
  for (const [subscriptionId, frame] of subscribedFrames) {
    socket.send(JSON.stringify(frame));
    const book = books.get(subscriptionId);
    if (book) socket.send(JSON.stringify(snapshotFromBook(subscriptionId, book)));
  }
});

console.log(`[feed] ${STREAM_URL}`);
const stopFeed = startLiveFeed({ url: STREAM_URL, key: STREAM_KEY, markets: MARKETS, onFrame: applyFrame });

server.listen(PORT, () => console.log(`open http://localhost:${PORT}`));

process.on("SIGINT", () => {
  stopFeed();
  server.close(() => process.exit(0));
});
