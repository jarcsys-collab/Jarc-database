// The form rules shared with the browser. site/assets/FormRules.js is the ONE implementation: the browser loads it as a
// script, the server requires it here, so both apply exactly the same conditions, required rules, validation and
// calculation previews. The production image copies site/ next to server/ (Dockerfile), as the app already serves it.
module.exports = require("../../../site/assets/FormRules.js");
