# Orderbook depth visualizer

A small webapp that streams Polymarket and Limitless orderbooks from the
ParlayX stream service and shows each book updating live: a bid and ask ladder
where levels flash as they change, the current spread and mid, and a cumulative
depth chart.

## How it works

```
stream service  ->  server.mjs (relay)  ->  browser (ladder + depth chart)
                     keeps the book          renders snapshot then delta
```

`server.mjs` keeps one connection to the stream service. It maintains the
authoritative book per subscription (applies snapshot then delta), and relays
the same v1 frames to every browser over a local WebSocket. The browser applies
those frames into its own copy of the book and redraws. The API key lives only
on the server and is never sent to the browser, which is the pattern you want
for any real deployment.

The frame handling in `public/app.js` is exactly what you would write against
the service. The relay only sits in front so the key stays server side and so a
browser that connects late gets the current book replayed.

## Run it

You need Node 22 or newer and a stream key (starts with `parx_stream_`). Stream
keys are issued by ParlayX in a closed release; if you do not have one, reach
out as described at https://docs.parlayx.com/streaming/overview.

1. Install dependencies:

   ```sh
   cd PX_Cookbook/orderbook-depth-visualizer
   npm install
   ```

2. Copy the example env file and set your key:

   ```sh
   cp .env.example .env
   ```

   ```sh
   PARX_STREAM_KEY=parx_stream_your_key_here
   PARX_STREAM_URL=wss://wss.parlayx.com/v1/orderbook
   ```

3. Edit `config.mjs` so `MARKETS` lists markets that are currently active (the
   examples shipped in the file go stale as markets resolve). See "Finding
   markets to subscribe to" below for how to look up current ids.

4. Start it and open http://localhost:8080:

   ```sh
   npm start
   ```

The server logs the `welcome` frame on connect, then a snapshot and a stream of
deltas flow into the UI.

## Finding markets to subscribe to

Each entry in `config.mjs` needs the venue native identifier of an outcome you
want to watch. Pick markets with real volume so the book actually moves. There
are two ways to get the identifiers: the ParlayX Markets API, or the venue APIs
directly. Use whichever you prefer; they yield the same `stream` object.

### Option A: the ParlayX Markets API

One key works across both venues and you do not need to know anything venue
specific ahead of time. Both calls authenticate with your API key in the
`x-api-key` header.

1. Search for a market and note its `venue` and `marketKey`
   (https://docs.parlayx.com/api-reference/markets/search-markets):

   ```sh
   curl -s "https://api.parlayx.com/v1/markets/search?q=world%20cup&limit=10" \
     -H "x-api-key: $PARX_API_KEY"
   ```

2. Fetch that market to get its outcomes, each with an `outcomeId` and a `name`
   (https://docs.parlayx.com/api-reference/markets/get-market):

   ```sh
   curl -s "https://api.parlayx.com/v1/markets/polymarket/<marketKey>" \
     -H "x-api-key: $PARX_API_KEY"
   ```

### Option B: the venue APIs directly

If you already work with a venue, you can pass its native ids and slugs straight
into `config.mjs`.

Polymarket outcomes are identified by an ERC1155 token id. List active markets
by 24 hour volume and read `outcomes` alongside `clobTokenIds` (index aligned,
so position 0 is "Yes", position 1 is "No"):

```sh
curl -s "https://gamma-api.polymarket.com/markets?closed=false&active=true&order=volume24hr&ascending=false&limit=10" \
  | python3 -c 'import sys,json; [print(m["question"], json.loads(m["outcomes"]), json.loads(m["clobTokenIds"])) for m in json.load(sys.stdin)]'
```

Limitless CLOB markets are identified by their slug. List active markets and
keep the ones with `tradeType` of `clob` that are not expired:

```sh
curl -s "https://api.limitless.exchange/markets/active?limit=30" \
  | python3 -c 'import sys,json; [print(m["slug"], "|", m["title"]) for m in json.load(sys.stdin)["data"] if m.get("tradeType")=="clob" and not m.get("expired")]'
```

### Build the stream object

Either way, drop the ids into the `stream` field of a `config.mjs` entry:

```js
/* Polymarket: outcomeId is the ERC1155 token id of the outcome */
{ venue: "polymarket", outcomeId: "<outcomeId>" }

/* Limitless CLOB: marketKey is the slug, outcomeId is the outcome name */
{ venue: "limitless", kind: "clob", marketKey: "<slug>", outcomeId: "YES" }
```

Markets resolve and Limitless crypto markets (the "Up or Down" series) roll over
on a fixed cadence, so subscribe to markets that are currently open and refresh
`config.mjs` when one closes.

## The protocol, briefly

The server authenticates with the WebSocket subprotocols
`["parlayx.v1", "key.<your key>"]`, waits for the `welcome` frame, then sends:

```json
{ "type": "subscribe", "markets": [{ "venue": "polymarket", "outcomeId": "..." }] }
```

For each subscription the service replies with `subscribed` (carrying a
`subscriptionId`), one `snapshot` (full `bids` and `asks`), then a continuous
stream of `delta` frames. A delta `change` with `size: 0` deletes that price
level; any other size sets it. `status` frames report the health of a
subscription (`live`, `resyncing`, `closed`, `unavailable`).

Full reference:

- Streaming overview: https://docs.parlayx.com/streaming/overview
- Connect and subscribe quickstart: https://docs.parlayx.com/streaming/quickstart
- Protocol (every frame, sequencing, errors): https://docs.parlayx.com/streaming/protocol
- Markets API (look up ids to subscribe to): https://docs.parlayx.com/api-reference/markets/search-markets

## Files

| File            | Role                                                          |
| --------------- | ------------------------------------------------------------- |
| `server.mjs`    | Static file server, browser relay, authoritative book per sub |
| `live-feed.mjs` | Connects to the stream service, forwards frames               |
| `config.mjs`    | The list of markets to subscribe to                           |
| `public/`       | The browser app (ladder, depth chart, flashing)               |
