// TEST-ONLY server for browser tests of resource mode: the real app (createApp + the real data layer, services and
// validation) on the in-memory fake MongoDB, plus controls. Never imported by src/ and never started by npm start.
//
//   node tests/support/resource-server.js <port>
//   POST /__test/config { down: bool, delay: ms }  → database unavailable / slow API responses
//   POST /__test/reset                             → empty database (only the development user remains)
//   GET  /__test/stats                             → API request counters
const express = require("express");
const { MongoConnection } = require("../../src/db/connection");
const { ensureDatabase } = require("../../src/db/bootstrap");
const { createDataLayer } = require("../../src/data-layer");
const { ensureDevelopmentActor } = require("../../src/context/dev-actor");
const { createApp } = require("../../src/app");
const { MemoryStateRepository } = require("../../src/repositories/memory-state-repository");
const { FakeMongoClient } = require("./fake-mongo");

(async () => {
  const port = Number(process.argv[2] || 3102);
  const fake = new FakeMongoClient();
  const connection = new MongoConnection({ uri: "mongodb://fake.invalid", dbName: "jarc_database", createClient: () => fake });
  await connection.connect();
  await ensureDatabase(connection.db);
  const dataLayer = createDataLayer({ connection, logger: { error() {} } });
  const devActor = await ensureDevelopmentActor(dataLayer.repos.users, { environment: "test" });
  const app = createApp({ repository: new MemoryStateRepository(), environment: "test", dataLayer, devActor, logger: { error() {} } });
  const sim = { delay: 0, requests: 0, writes: 0 };

  const outer = express();
  outer.post("/__test/config", express.json(), (req, res) => { fake.down = Boolean(req.body.down); sim.delay = Number(req.body.delay || 0); res.json({ down: fake.down, delay: sim.delay }); });
  outer.post("/__test/reset", (req, res) => {
    for (const collection of connection.db.collections.values()) if (collection.name !== "users") collection.docs = [];
    sim.requests = 0; sim.writes = 0;
    res.json({ ok: true });
  });
  outer.get("/__test/stats", (req, res) => res.json(sim));
  outer.use("/api/v1", async (req, res, next) => {
    sim.requests += 1;
    if (req.method !== "GET") sim.writes += 1;
    if (sim.delay) await new Promise((resolve) => setTimeout(resolve, sim.delay));
    next();
  });
  outer.use((req, res, next) => app(req, res, next));
  outer.listen(port, "127.0.0.1", () => console.log(`resource test server on http://127.0.0.1:${port}/`));
})();
