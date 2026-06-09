/* Markets the demo subscribes to.

   Each entry pairs a human label (shown in the UI) with the MarketStream
   identifier the service expects on a subscribe frame. `stream` is sent
   verbatim, so each one must be a real, currently active market.

   MarketStream shapes:
     Polymarket : { venue: "polymarket", outcomeId: "<ERC1155 token id>" }
     Limitless  : { venue: "limitless", kind: "clob", marketKey: "<slug>", outcomeId: "YES" }

   The entries below are examples and will go stale as markets resolve (the
   Limitless hourly slug rolls over every hour). See the README section
   "Finding markets to subscribe to" for how to look up current ids. */

export const MARKETS = [
  {
    label: "Peru election: Roberto Sanchez (Yes)",
    stream: {
      venue: "polymarket",
      outcomeId: "40073700561695212653451049120779209383948898865772011302940523990213422296817",
    },
  },
  {
    label: "Peru election: Keiko Fujimori (Yes)",
    stream: {
      venue: "polymarket",
      outcomeId: "64703998724474008677827057135436893758254552168142785204605792475717308499827",
    },
  },
  {
    label: "World Cup 2026: Uruguay to win (Yes)",
    stream: {
      venue: "polymarket",
      outcomeId: "97239126062673310243763617236644392945530356142765650402171508075574679292913",
    },
  },
  {
    /* Limitless hourly markets roll over every hour, so this slug goes stale.
       Look up a current one as described in the README. */
    label: "BTC up or down, hourly (Limitless)",
    stream: {
      venue: "limitless",
      kind: "clob",
      marketKey: "btc-up-or-down-hourly-1780988439523",
      outcomeId: "YES",
    },
  },
];

/* Stable key for one market, used to route frames to the right UI panel.
   Mirrored in public/app.js so the browser derives the same key. */
export function marketKey(stream) {
  if (stream.venue === "limitless") {
    return `limitless:${stream.marketKey}:${stream.outcomeId}`;
  }
  return `${stream.venue}:${stream.outcomeId}`;
}
