// TEST-ONLY server for browser integration tests: the real app (createApp + MemoryStateRepository) wrapped with
// controls for latency and failures on /api/v1/state. Never imported by src/ and never started by npm start.
//
//   node tests/support/controlled-server.js <port>
//   POST /__test/config  { delay, failNext, failMethod: "GET"|"PUT"|"ANY", failStatus, mode: "status"|"drop"|"hang" }
//   GET  /__test/stats   → request counters and the current settings
//   GET  /__test/state   → the stored document without latency (for assertions)
//   POST /__test/restart → a fresh repository, as after a server restart
const express = require("express");
const { createApp } = require("../../src/app");
const { MemoryStateRepository } = require("../../src/repositories/memory-state-repository");

const port = Number(process.argv[2] || 3101);
const defaults = () => ({ delay: 0, failNext: 0, failMethod: "ANY", failStatus: 500, mode: "status" });
const sim = { ...defaults(), gets: 0, puts: 0 };
let repository, app;
const build = () => { repository = new MemoryStateRepository(); app = createApp({ repository, environment: "test", logger: { error() {} } }); };
build();

const outer = express();
outer.post("/__test/config", express.json(), (req, res) => { Object.assign(sim, defaults(), req.body); res.json(sim); });
outer.get("/__test/stats", (req, res) => res.json(sim));
outer.get("/__test/state", async (req, res) => res.json(await repository.loadState()));
outer.post("/__test/restart", (req, res) => { build(); sim.gets = 0; sim.puts = 0; res.json({ ok: true }); });
outer.use("/api/v1/state", async (req, res, next) => {
  if (req.method === "GET") sim.gets += 1;
  if (req.method === "PUT") sim.puts += 1;
  if (sim.delay) await new Promise((resolve) => setTimeout(resolve, sim.delay));
  if (sim.failNext > 0 && (sim.failMethod === "ANY" || sim.failMethod === req.method)) {
    sim.failNext -= 1;
    if (sim.mode === "drop") return req.socket.destroy();
    if (sim.mode === "hang") return undefined;
    return res.status(sim.failStatus).json({ error: { code: "SIMULATED", message: "Simulated failure" } });
  }
  return next();
});
outer.use((req, res, next) => app(req, res, next));
outer.listen(port, "127.0.0.1", () => console.log(`controlled test server on http://127.0.0.1:${port}/`));
