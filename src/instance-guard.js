const net = require("node:net");
const { createHash } = require("node:crypto");

function defaultPort(clientId) {
  return 20000 + createHash("sha256").update(clientId).digest().readUInt32BE(0) % 40000;
}

// An exclusive loopback listener is released by the OS even after a crash.
// Key by Client ID so different checkouts using the same app cannot compete.
async function acquireInstanceGuard(clientId, port = defaultPort(clientId)) {
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("TWITCH_INSTANCE_PORT must be an integer between 1024 and 65535.");
  }
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  }).catch(error => {
    if (error.code === "EADDRINUSE") {
      throw new Error(`Another Hajimatta instance or application is using 127.0.0.1:${port}; startup stopped before changing Twitch subscriptions. Stop the existing instance. If an unrelated application uses this port, set TWITCH_INSTANCE_PORT consistently in all copies.`);
    }
    throw error;
  });
  server.unref();
  return { port, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

module.exports = { acquireInstanceGuard, defaultPort };
