// Shared message-shape reference for the extension side of the wire protocol (Piece 7).
// The Worker (server/src/index.js) implements the matching server-side shapes.
//
// client -> server
//   { type: "hello", role: "host" | "guest", name }
//   { type: "setVideo", descriptor, frameUrl, pageUrl, duration }  // host only; duration optional (null if unknown)
//   { type: "clearVideo" }                                         // host only, e.g. navigated away
//   { type: "state", play, currentTime, rate, at }                 // any peer — symmetric control, on play/pause/seek
//   { type: "heartbeat", currentTime, at }                         // any peer, periodic, only while playing
//   { type: "ping", t0 }                                           // clock-offset handshake
//   { type: "bye" }                                                // sent just before an intentional disconnect
//
// server -> client
//   { type: "sync", play, currentTime, rate, at, descriptor, frameUrl, pageUrl, duration }
//   { type: "state", play, currentTime, rate, at }
//   { type: "heartbeat", currentTime, at }
//   { type: "peers", count }
//   { type: "pong", t0, t1 }                              // t1 = server's clock when it saw t0

export const MessageType = Object.freeze({
  HELLO: "hello",
  SET_VIDEO: "setVideo",
  CLEAR_VIDEO: "clearVideo",
  STATE: "state",
  HEARTBEAT: "heartbeat",
  PING: "ping",
  BYE: "bye",
  SYNC: "sync",
  PEERS: "peers",
  PONG: "pong"
});

export const Role = Object.freeze({
  HOST: "host",
  GUEST: "guest"
});
