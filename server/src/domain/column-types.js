// The column type registry shared with the browser. site/assets/ColumnTypes.js is the ONE implementation (pure: no DOM, no
// I/O, no require, so it is safe on worker threads): the browser loads it as a script, the server requires it here, so both
// apply exactly the same column display settings rules (cleanSettings, settingsForType). The production image copies site/
// next to server/ (Dockerfile), as for FormRules.js.
module.exports = require("../../../site/assets/ColumnTypes.js");
