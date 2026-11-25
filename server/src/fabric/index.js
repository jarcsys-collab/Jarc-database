// Fabric Data (read-only datasets from Microsoft Fabric's MongoDB: sales → FactSales, inventory → FactInventory): what app.js,
// server.js and the Fabric API token routes use. Required only by app.js / server.js and routes, never by src/domain/* or
// src/workers/* (worker threads must stay light).
const { FabricConnection } = require("./connection");
const { FabricIndexes } = require("./indexes");
const { FabricRepository } = require("./repository");
const { FabricService } = require("./service");
const { DatasetSource } = require("./source");
const { DATASETS, DATASET_NAMES, datasetNamed } = require("./datasets");
const { fabricDataRouter, fabricLimiter } = require("./router");
const { canReadFabric, canReadFabricCost, canReadFabricSensitive, canManageFabricApi, canOverseeFabricApi, fabricIdentityAccess, requireFabricDataRead } = require("./access");

// The service stack for config.fabricData (enabled). Nothing connects until the first Fabric request.
// createClient: tests only (a fake MongoClient factory).
function createFabricData({ config, logger = console, createClient, now } = {}) {
  if (!config?.enabled) throw new Error("createFabricData needs config.fabricData with the switch on.");
  const connection = new FabricConnection({ uri: config.uri, dbName: config.dbName, poolSize: config.poolSize, queryTimeMs: config.queryTimeMs, logger, ...(createClient ? { createClient } : {}) });
  let indexes = null;
  const sources = {};
  // A query showed that a collection or an index is gone: drop what's cached for that collection.
  const onInvalidate = (kind, collection) => {
    if (collection === DATASETS.sales.collection) indexes?.invalidate();
    for (const source of Object.values(sources)) if (source.dataset.collection === collection) source.invalidate();
  };
  // One operation slot fewer than the pool (at least one): a connection stays free while slow queries run.
  const repository = new FabricRepository({ connection, queryTimeMs: config.queryTimeMs, logger, onInvalidate, maxInFlight: Math.max(1, (config.poolSize || 5) - 1) });
  indexes = new FabricIndexes({ listIndexes: () => repository.listIndexes(DATASETS.sales.collection) });
  for (const name of DATASET_NAMES) sources[name] = new DatasetSource({ dataset: DATASETS[name], repository, scanMax: config.unindexedScanMax ?? 20000 });
  const service = new FabricService({ repository, sources, indexes, config, connection, ...(now ? { now } : {}) });
  return { config, connection, repository, indexes, sources, service, close: () => connection.close() };
}

module.exports = { createFabricData, FabricConnection, FabricIndexes, FabricRepository, FabricService, DatasetSource, DATASETS, DATASET_NAMES, datasetNamed, fabricDataRouter, fabricLimiter, canReadFabric, canReadFabricCost, canReadFabricSensitive, canManageFabricApi, canOverseeFabricApi, fabricIdentityAccess, requireFabricDataRead };
