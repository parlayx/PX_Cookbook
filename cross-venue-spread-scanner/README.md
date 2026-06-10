# Cross-venue spread scanner

ParlayX lists the same real-world market on both Polymarket and Limitless, and
the two orderbooks move independently, so the same outcome often has a
different price on each venue. This recipe surfaces that gap two ways:

- **`scan`**, a one-off **REST** snapshot: search for matched markets and print,
  per outcome, the cheapest venue to buy and the richest to sell.
- **`live`**, a real-time **WebSocket** monitor: stream both books for one
  matched market and watch the cross-venue spread move once a second.

Together they show both ParlayX surfaces, the REST Markets API and the
streaming orderbook feed, and the one thing that makes the platform
distinctive: the same market, priced two ways, in one place.

The only dependency is [`ws`](https://github.com/websockets/ws) (for the
streaming mode); everything else is built-in `fetch`.

## How it works

```
scan:  search  ->  /v1/markets/match  ->  /v1/markets/{venue}/{key} (bid/ask)  ->  compare + print
live:  search  ->  /v1/markets/match  ->  WebSocket subscribe (both venues)    ->  apply snapshot+delta, print each second
```

`scan` reads executable `bid`/`ask` from the single-market endpoint (the match
endpoint returns `mid` only). `live` discovers the same pair over REST, then
opens one WebSocket, subscribes to the outcome on **both** venues, and keeps each
book up to date (snapshot, then deltas; a `size: 0` change removes a level).

## Setup

You need Node 20.6 or newer.

```sh
cp .env.example .env
npm install
```

Set your keys in `.env`:

```sh
# REST key (markets, search, match), used by both modes.
PARX_API_KEY=parx_your_api_key_here
# Stream key (parx_stream_...), used by `live` only. Issued by ParlayX; see
# https://docs.parlayx.com/streaming/overview
PARX_STREAM_KEY=parx_stream_your_stream_key_here
```

## Run it

A search term is optional and defaults to `bitcoin`:

```sh
npm run scan -- "fed"      # one-off REST comparison
npm run live -- "taiwan"   # live streaming monitor (needs a stream key)
```

### `scan` output

```
Will the Fed increase interest rates by 25 bps after the July 2026 meeting?
  polymarket  vs  limitless
  YES  buy 0.052 @ limitless      sell 0.056 @ polymarket  ⚑ edge +0.004 (buy < sell across venues)
  NO   buy 0.944 @ polymarket     sell 0.948 @ limitless  ⚑ edge +0.004 (buy < sell across venues)
```

### `live` output

```
Monitoring: Will China invade Taiwan by end of 2026?  [outcome: Yes]

time     poly bid/ask     lim bid/ask      cross-venue
14:08:34 0.066/0.067      0.071/0.087      buy 0.067@poly sell 0.071@lim  EDGE +0.004
14:08:35 0.066/0.067      0.071/0.087      buy 0.067@poly sell 0.071@lim  EDGE +0.004
```

The `edge` / `EDGE` flag marks an outcome where the best bid on one venue sits
above the best ask on the other, buyable below where it is sellable. Treat it
as a signal to look closer, not guaranteed profit: prices are indicative, the
size at each level is limited, and fees and slippage apply. See
[Pricing and Execution](https://docs.parlayx.com/pricing-and-execution).

## Notes

- Not every market exists on both venues, so most search results are skipped.
  `scan` stops after the first few matched pairs; `live` monitors the first match.
- Markets resolve over time, so a query that matches today may not tomorrow.
  If a query finds nothing, try another (e.g. `"fed"`, `"taiwan"`).
- The API key never leaves your machine. In `live`, the stream key is used only
  to open the WebSocket from this process, never expose it to a browser.

## Files

| File           | Role                                                              |
| -------------- | ----------------------------------------------------------------- |
| `scan.mjs`     | REST snapshot: search, match, fetch bid/ask, compare, print       |
| `live.mjs`     | Streaming monitor: discover over REST, then subscribe + render live |
| `.env.example` | Template for your API and stream keys                             |

## Reference

- Search markets: https://docs.parlayx.com/api-reference/markets/search-markets
- Find market matches: https://docs.parlayx.com/api-reference/markets/find-market-matches
- Get market: https://docs.parlayx.com/api-reference/markets/get-market
- Streaming overview: https://docs.parlayx.com/streaming/overview
- Streaming protocol: https://docs.parlayx.com/streaming/protocol
- Pricing and execution: https://docs.parlayx.com/pricing-and-execution
