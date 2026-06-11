/* Live cross-venue spread monitor.

   The companion to scan.mjs. Where scan.mjs takes a one-off REST snapshot, this
   streams BOTH venues' orderbooks for the same market over a single WebSocket
   and prints the cross-venue spread as it moves in real time.

   It uses BOTH ParlayX surfaces:
     - REST  (PARX_API_KEY)    : discover a market listed on both venues.
     - Stream (PARX_STREAM_KEY) : subscribe to both books and apply snapshot+delta.

   Flow:
     1. REST search + match to find one market on both Polymarket and Limitless.
     2. Open wss://wss.parlayx.com/v1/orderbook (subprotocol auth), wait for welcome.
     3. Subscribe to the same outcome on both venues.
     4. Keep each book (snapshot then delta; size 0 deletes a level) and, once a
        second, print best bid/ask per venue plus the cross-venue buy/sell/edge.

   Docs:
     Streaming overview ... https://docs.parlayx.com/streaming/overview
     Protocol ............. https://docs.parlayx.com/streaming/protocol
     Find market matches .. https://docs.parlayx.com/api-reference/markets/find-market-matches
*/

import WebSocket from "ws";

try {
  process.loadEnvFile(".env");
} catch {}

const API_KEY = process.env.PARX_API_KEY || "";
const STREAM_KEY = process.env.PARX_STREAM_KEY || "";
const BASE_URL = process.env.PARX_API_URL || "https://api.parlayx.com";
const STREAM_URL = process.env.PARX_STREAM_URL || "wss://wss.parlayx.com/v1/orderbook";

if (!API_KEY || !STREAM_KEY) {
  console.error("Set PARX_API_KEY and PARX_STREAM_KEY in .env (copy .env.example to .env).");
  process.exit(1);
}

const QUERY = process.argv.slice(2).join(" ").trim() || "bitcoin";
const SOURCE_VENUE = "polymarket";

async function api(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) throw new Error(`${res.status} ${path} — ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* REST: find the first market matching QUERY that exists on both venues. */
async function discoverPair() {
  const { markets } = await api("/v1/markets/search", { q: QUERY, venues: SOURCE_VENUE, limit: "20" });
  for (const m of (markets || []).filter((x) => x.status === "open")) {
    let res;
    try {
      res = await api("/v1/markets/match", { marketVenue: SOURCE_VENUE, marketKey: m.marketKey });
    } catch {
      continue;
    }
    const poly = (res.matches || []).find((x) => x.venue === "polymarket");
    const lim = (res.matches || []).find((x) => x.venue === "limitless");
    if (!poly?.outcomes?.[0] || !lim?.marketSlug) continue;

    /* Track the first outcome (e.g. "Yes"). Each venue identifies that outcome by
       its own numeric token id, so pair them up by name. On Limitless the stream
       expects the outcome's token id (the same value the Markets API returns),
       NOT the literal "YES"/"NO". */
    const outcome = poly.outcomes[0].name;
    const limOutcome = (lim.outcomes || []).find((o) => o.name.toUpperCase() === outcome.toUpperCase());
    if (!limOutcome) continue;

    return {
      title: poly.title,
      outcome,
      polyOutcomeId: poly.outcomes[0].outcomeId,
      limSlug: lim.marketSlug,
      limOutcomeId: limOutcome.outcomeId,
    };
  }
  return null;
}

/* A book is two maps: price -> size, for bids and asks. */
function newBook() {
  return { bids: new Map(), asks: new Map() };
}
function applySnapshot(book, frame) {
  book.bids = new Map(frame.bids.map((l) => [l.price, l.size]));
  book.asks = new Map(frame.asks.map((l) => [l.price, l.size]));
}
function applyDelta(book, frame) {
  for (const c of frame.changes) {
    const side = c.side === "bid" ? book.bids : book.asks;
    if (c.size === 0) side.delete(c.price);
    else side.set(c.price, c.size);
  }
}
const bestBid = (book) => (book.bids.size ? Math.max(...book.bids.keys()) : null);
const bestAsk = (book) => (book.asks.size ? Math.min(...book.asks.keys()) : null);
const px = (n) => (n == null ? " — " : n.toFixed(3));

async function main() {
  console.log(`Discovering a "${QUERY}" market on both venues…`);
  const pair = await discoverPair();
  if (!pair) {
    console.log(`No cross-venue match for "${QUERY}". Try another (e.g. "taiwan", "fed").`);
    process.exit(0);
  }
  console.log(`Monitoring: ${pair.title}  [outcome: ${pair.outcome}]`);
  console.log("Connecting to the stream…\n");

  const books = { polymarket: newBook(), limitless: newBook() };
  const subToVenue = new Map(); /* subscriptionId -> venue */

  const ws = new WebSocket(STREAM_URL, ["parlayx.v1", `key.${STREAM_KEY}`]);

  ws.on("unexpected-response", (_req, res) => {
    console.error(`Stream auth rejected (HTTP ${res.statusCode}). Check PARX_STREAM_KEY.`);
    process.exit(1);
  });

  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    switch (f.type) {
      case "welcome":
        ws.send(JSON.stringify({
          type: "subscribe",
          markets: [
            { venue: "polymarket", outcomeId: pair.polyOutcomeId },
            { venue: "limitless", kind: "clob", marketKey: pair.limSlug, outcomeId: pair.limOutcomeId },
          ],
        }));
        break;
      case "subscribed":
        subToVenue.set(f.subscriptionId, f.market.venue);
        break;
      case "snapshot": {
        const venue = subToVenue.get(f.subscriptionId);
        if (venue) applySnapshot(books[venue], f);
        break;
      }
      case "delta": {
        const venue = subToVenue.get(f.subscriptionId);
        if (venue) applyDelta(books[venue], f);
        break;
      }
      case "status":
        /* On resync, drop the affected book and wait for the fresh snapshot. */
        if (f.state === "resyncing") {
          const venue = subToVenue.get(f.subscriptionId);
          if (venue) books[venue] = newBook();
        }
        break;
      case "error":
        console.error(`stream error: ${f.code} ${f.message}`);
        break;
      case "goodbye":
        console.error(`server closing connection (${f.reason}); exiting.`);
        ws.close();
        process.exit(0);
    }
  });

  ws.on("close", () => {
    console.error("\nconnection closed.");
    process.exit(0);
  });
  ws.on("error", (e) => {
    console.error("socket error:", e.message);
    process.exit(1);
  });

  /* Render once a second: per-venue top of book + the cross-venue picture. */
  let printedHeader = false;
  setInterval(() => {
    const pb = books.polymarket, lb = books.limitless;
    const pBid = bestBid(pb), pAsk = bestAsk(pb);
    const lBid = bestBid(lb), lAsk = bestAsk(lb);
    if (pAsk == null && lAsk == null) return; /* nothing to show yet */

    /* Cheapest ask to buy, highest bid to sell, across the two venues. */
    const asks = [
      { venue: "poly", price: pAsk },
      { venue: "lim", price: lAsk },
    ].filter((x) => x.price != null);
    const bids = [
      { venue: "poly", price: pBid },
      { venue: "lim", price: lBid },
    ].filter((x) => x.price != null);
    const buy = asks.sort((x, y) => x.price - y.price)[0]; /* lowest ask */
    const sell = bids.sort((x, y) => y.price - x.price)[0]; /* highest bid */
    const edge = buy && sell ? sell.price - buy.price : null;
    const flag = edge != null && edge > 0 ? `  EDGE +${px(edge)}` : "";

    if (!printedHeader) {
      console.log(`${"time".padEnd(8)} ${"poly bid/ask".padEnd(16)} ${"lim bid/ask".padEnd(16)} cross-venue`);
      printedHeader = true;
    }
    const t = new Date().toISOString().slice(11, 19);
    const polyCol = `${px(pBid)}/${px(pAsk)}`.padEnd(16);
    const limCol = `${px(lBid)}/${px(lAsk)}`.padEnd(16);
    const cross = buy && sell ? `buy ${px(buy.price)}@${buy.venue} sell ${px(sell.price)}@${sell.venue}${flag}` : "";
    console.log(`${t} ${polyCol} ${limCol} ${cross}`);
  }, 1000);

  process.on("SIGINT", () => {
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
