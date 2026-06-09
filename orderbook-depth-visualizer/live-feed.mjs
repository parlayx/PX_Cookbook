/* Live feed: connects to the ParlayX stream service and forwards every frame
   it receives. The API key stays here on the server and is never sent to the
   browser. Reconnects with a fixed backoff so the demo survives the connection
   ttl close (goodbye: ttl) and transient drops. */

import WebSocket from "ws";

export function startLiveFeed({ url, key, markets, onFrame }) {
  let socket;
  let stopped = false;
  let reconnectTimer;

  function connect() {
    socket = new WebSocket(url, ["parlayx.v1", `key.${key}`]);

    socket.on("open", () => console.log(`[live] connected ${url}`));

    socket.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame.type === "welcome") {
        console.log(
          `[live] welcome customer=${frame.customerId} maxSubs=${frame.limits?.maxSubscriptionsPerConnection}`,
        );
        socket.send(JSON.stringify({ type: "subscribe", markets: markets.map((m) => m.stream) }));
      }

      if (frame.type === "error") {
        console.error(`[live] error code=${frame.code} message=${frame.message}`);
      }

      onFrame(frame);
    });

    socket.on("close", (code, reason) => {
      console.log(`[live] closed code=${code} reason=${reason || "(none)"}`);
      if (!stopped) reconnectTimer = setTimeout(connect, 2000);
    });

    socket.on("error", (err) => console.error("[live] socket error", err.message));
  }

  connect();

  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close();
  };
}
