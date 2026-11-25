// Record search engines (RECORD_SEARCH_ENGINE). regex (default) returns null: search-service.js then behaves exactly as before
// and nothing here runs. shadow / atlas: atlas-engine.js. config: config/index.js recordSearchEngine.
const { AtlasRecordSearch, SearchEngineUnavailable, MODES } = require("./atlas-engine");

function createRecordSearchEngine({ repos, logger = console, config = null }) {
  if (!config || config.mode === "regex") return null;
  return new AtlasRecordSearch({ repos, logger, mode: config.mode, indexName: config.atlasIndex, shadowSample: config.shadowSamplePercent / 100 });
}

module.exports = { createRecordSearchEngine, AtlasRecordSearch, SearchEngineUnavailable, MODES };
