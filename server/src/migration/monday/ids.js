// Stable migration identifiers. Every destination ID is derived from the source account, board and object ID, so a
// dry run is deterministic and a retried import produces exactly the same documents (the unique indexes then make a
// second insert impossible instead of creating a duplicate).
const crypto = require("crypto");
const { ObjectId } = require("mongodb");

const PROVIDER = "monday.com";
const MAPPING_PROVIDER = "monday-migration"; // integrationMappings namespace, separate from the sync integration ("monday")
const namespaceOf = (account, boardId) => `${PROVIDER}:${account}:${boardId}`;

const digest = (...parts) => crypto.createHash("sha256").update(parts.join("\u0000")).digest();
// A deterministic ObjectId (12 bytes of a SHA-256) for kind + source ID within one migration namespace.
const objectIdFor = (namespace, kind, sourceId) => new ObjectId(digest(namespace, kind, String(sourceId)).subarray(0, 12));
// A deterministic group ID matching board-schema's GROUP_ID (grp_ + 6-40 letters/digits).
const groupIdFor = (namespace, sourceGroupId) => `grp_${digest(namespace, "group", String(sourceGroupId)).toString("hex").slice(0, 16)}`;
// Record legacy IDs (records.uniq_board_legacy_id) and board legacy IDs (boards.uniq_workspace_legacy_id).
const legacyIdFor = (kind, sourceId) => `monday-${kind}-${sourceId}`;

module.exports = { PROVIDER, MAPPING_PROVIDER, namespaceOf, objectIdFor, groupIdFor, legacyIdFor };
