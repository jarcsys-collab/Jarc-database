// PRINTS (never runs) the mongosh commands for the record search Atlas index, for an approved operator to run by hand:
//   node src/services/search-engines/atlas-index-commands.js [indexName]
// Nothing here opens a connection, reads .env or touches any database. Creating the production index is a separate,
// approved step (plan phase 4); the status check is read-only.
const definition = require("./atlas-index-definition.json");

const DB = "jarc_database", COLLECTION = "recordSearch";

function commands(indexName = "jarc_text") {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(indexName)) throw new Error("index name must be 1-64 letters, digits, _ or -");
  const json = JSON.stringify(definition, null, 2);
  return {
    create: `use ${DB}\ndb.runCommand({ createSearchIndexes: "${COLLECTION}", indexes: [{ name: "${indexName}", type: "search", definition: ${json.replace(/\n/g, "\n  ")} }] })`,
    status: `use ${DB}\ndb.${COLLECTION}.aggregate([{ $listSearchIndexes: { name: "${indexName}" } }, { $project: { name: 1, status: 1, queryable: 1 } }])`,
    drop: `use ${DB}\ndb.${COLLECTION}.dropSearchIndex("${indexName}")`
  };
}

if (require.main === module) {
  const c = commands(process.argv[2] || "jarc_text");
  process.stdout.write([
    "// Printed only. Nothing was run. Each step needs its own approval.",
    "// 1. Create (plan phase 4; build load for a few minutes):", c.create, "",
    "// 2. Read-only status check: repeat until queryable: true (status READY):", c.status, "",
    "// Rollback (safe while RECORD_SEARCH_ENGINE=regex):", c.drop, ""
  ].join("\n"));
}

module.exports = { commands, definition };
