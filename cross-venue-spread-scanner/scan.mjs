/* Cross-venue spread scanner.

   ParlayX lists the same real-world market on more than one venue, and the two
   books price it independently. This recipe finds markets that exist on BOTH
   Polymarket and Limitless and reports, per outcome, the cheapest venue to BUY
   and the richest venue to SELL — and flags any cross-venue edge (when the best
   bid on one venue is above the best ask on the other).

   Flow (all REST, one API key, zero dependencies):
     1. Search one venue for markets matching your query.
     2. For each, call /v1/markets/match to find the same market on the other venue.
     3. For each matched pair, fetch the full single-market on each venue to get
        executable bid/ask (the match endpoint returns mid only).
     4. Compare and print.

   Docs:
     Search ........ https://docs.parlayx.com/api-reference/markets/search-markets
     Match ......... https://docs.parlayx.com/api-reference/markets/find-market-matches
     Get market .... https://docs.parlayx.com/api-reference/markets/get-market
     Pricing ....... https://docs.parlayx.com/pricing-and-execution
*/

try {
  process.loadEnvFile(".env");
} catch {}

const API_KEY = process.env.PARX_API_KEY || "";
const BASE_URL = process.env.PARX_API_URL || "https://api.parlayx.com";

if (!API_KEY) {
  console.error("Set PARX_API_KEY in .env (copy .env.example to .env).");
  process.exit(1);
}

/* The market to scan from. Defaults to "bitcoin"; override on the CLI:
     node scan.mjs "fed rate"
   SOURCE_VENUE is the venue we search first; matches are looked up on the other. */
const QUERY = process.argv.slice(2).join(" ").trim() || "bitcoin";
const SOURCE_VENUE = "polymarket";
const MAX_PAIRS = 5; /* stop after this many matched pairs, to keep output tight */

async function api(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${path} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

/* The match endpoint returns mid only, so fetch the full market for bid/ask. */
async function getMarket(venue, marketKey) {
  const { market } = await api(`/v1/markets/${venue}/${encodeURIComponent(marketKey)}`);
  return market;
}

/* Index a market's outcomes by name (YES/NO/...) for easy cross-venue pairing. */
function outcomesByName(market) {
  const byName = new Map();
  for (const o of market.outcomes || []) byName.set(o.name.toUpperCase(), o);
  return byName;
}

const fmt = (n) => (n == null ? "  —  " : n.toFixed(3));

function reportPair(title, a, b) {
  /* a, b are { venue, market } for the two venues holding this market. */
  console.log(`\n${title}`);
  console.log(`  ${a.venue}  vs  ${b.venue}`);

  const aBy = outcomesByName(a.market);
  const bBy = outcomesByName(b.market);
  const names = [...new Set([...aBy.keys(), ...bBy.keys()])];

  for (const name of names) {
    const oa = aBy.get(name);
    const ob = bBy.get(name);
    if (!oa || !ob) continue; /* only compare outcomes present on both venues */

    /* Cheapest place to BUY = lowest ask. Richest place to SELL = highest bid. */
    const asks = [
      { venue: a.venue, px: oa.ask },
      { venue: b.venue, px: ob.ask },
    ].filter((x) => x.px != null);
    const bids = [
      { venue: a.venue, px: oa.bid },
      { venue: b.venue, px: ob.bid },
    ].filter((x) => x.px != null);

    const bestBuy = asks.sort((x, y) => x.px - y.px)[0];
    const bestSell = bids.sort((x, y) => y.px - x.px)[0];
    const edge = bestBuy && bestSell ? bestSell.px - bestBuy.px : null;

    const buyStr = bestBuy ? `${fmt(bestBuy.px)} @ ${bestBuy.venue}` : "  —  ";
    const sellStr = bestSell ? `${fmt(bestSell.px)} @ ${bestSell.venue}` : "  —  ";
    const flag = edge != null && edge > 0 ? `  ⚑ edge +${fmt(edge)} (buy < sell across venues)` : "";

    console.log(`  ${name.padEnd(4)} buy ${buyStr.padEnd(22)} sell ${sellStr}${flag}`);
  }
}

async function main() {
  console.log(`Scanning "${QUERY}" for markets listed on both venues…`);

  const { markets } = await api("/v1/markets/search", {
    q: QUERY,
    venues: SOURCE_VENUE,
    limit: "20",
  });
  const open = (markets || []).filter((m) => m.status === "open");
  if (!open.length) {
    console.log("No open markets found for that query.");
    return;
  }

  let pairs = 0;
  for (const m of open) {
    if (pairs >= MAX_PAIRS) break;

    let matchRes;
    try {
      matchRes = await api("/v1/markets/match", {
        marketVenue: SOURCE_VENUE,
        marketKey: m.marketKey,
      });
    } catch {
      continue; /* not all markets have a match; skip quietly */
    }

    const matches = matchRes.matches || [];
    const src = matches.find((x) => x.venue === SOURCE_VENUE);
    const other = matches.find((x) => x.venue !== SOURCE_VENUE);
    if (!src || !other) continue; /* need the same market on a second venue */

    /* Fetch full markets (with bid/ask) on both venues. */
    const otherKey = other.marketSlug || other.marketKey;
    const [aMarket, bMarket] = await Promise.all([
      getMarket(SOURCE_VENUE, m.marketKey),
      getMarket(other.venue, otherKey),
    ]);

    reportPair(src.title, { venue: SOURCE_VENUE, market: aMarket }, { venue: other.venue, market: bMarket });
    pairs += 1;
  }

  if (pairs === 0) {
    console.log("\nNo cross-venue matches for that query — try another (e.g. \"fed rate\", \"taiwan\").");
  } else {
    console.log(`\nDone — ${pairs} matched market(s).`);
    console.log("Prices are implied probability (0–1). 'buy' = lowest ask, 'sell' = highest bid across venues.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
