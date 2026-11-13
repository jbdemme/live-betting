// @ts-check
/**
 * Production server: Next.js app + Socket.io betting engine on a single port,
 * so the whole app deploys as one web service with one URL.
 *
 *   pnpm build && pnpm start
 *
 * Local development still uses two processes (`pnpm dev` + `node server.js`).
 */

const http = require("node:http");
// At runtime `require("next")` is the factory itself; its typings only describe the ESM default export.
const next = /** @type {typeof import("next").default} */ (/** @type {unknown} */ (require("next")));
const { Server } = require("socket.io");
const { attachEngine, handleHealth } = require("./server");

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

const app = next({ dev });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const httpServer = http.createServer((req, res) => {
      if (handleHealth(req, res)) return;
      void handle(req, res);
    });

    // Same origin as the page, so no CORS config is needed.
    attachEngine(new Server(httpServer));

    httpServer.listen(port, host, () => {
      console.log(`[app] Next.js + betting engine listening on http://${host}:${port} (${dev ? "dev" : "production"})`);
    });
  })
  .catch((/** @type {unknown} */ err) => {
    console.error(err);
    process.exit(1);
  });
