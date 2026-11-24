// Fabric Data → API Management → Documentation. Text only: placeholders stand in for every secret and value (never real data),
// and the base URL is this server's own. Paths follow the Fabric Data API contract v2 (/api/v1/external/fabric/*): the Sales and
// Inventory datasets only, described by their own /schema.
const FabricApiDocs = {
  html(esc, origin) {
    const base = `${origin}/api/v1/external/fabric`;
    const code = (id, label, text) => `<figure class="apitok-code"><figcaption><span>${esc(label)}</span><button type="button" class="button secondary" data-action="fabric-api-copy-example" data-example="${id}">Copy</button></figcaption><pre id="fabric-api-example-${id}" tabindex="0"><code>${esc(text)}</code></pre></figure>`;
    const c = (t) => `<code>${esc(t)}</code>`;
    const table = (head, rows) => `<div class="apitok-table-scroll" tabindex="0"><table class="apitok-doc-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td${i === 0 ? ' class="apitok-nowrap"' : ""}>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const curl = `# Keep the token in your shell, not in scripts:\n#   export JARC_FABRIC_TOKEN="paste-your-token-here"\n\n# What the token can read, and each dataset's state:\ncurl -H "Authorization: Bearer $JARC_FABRIC_TOKEN" "${base}/status"\n\n# The fields, filters and sorts of a dataset (sales or inventory):\ncurl -H "Authorization: Bearer $JARC_FABRIC_TOKEN" "${base}/inventory/schema"\n\n# One page of rows (dates are UTC days; leave them out for the default window):\ncurl -H "Authorization: Bearer $JARC_FABRIC_TOKEN" \\\n  "${base}/sales/records?dateFrom=2026-01-01&dateTo=2026-01-31&limit=200&fields=FIELD_A,FIELD_B"\n\n# Next page: add &cursor=<pagination.nextCursor from the previous answer>, same filters.\n# One record (every field the token may read):\ncurl -H "Authorization: Bearer $JARC_FABRIC_TOKEN" "${base}/sales/records/RECORD_ID"`;
    const m = `// Power BI: Get data → Blank query → Advanced editor.\n// Create a parameter named FabricToken holding the token; when asked for credentials choose Anonymous.\nlet\n    BaseUrl = "${origin}",\n    Dataset = "inventory",   // or "sales"\n    GetPage = (cursor as nullable text) =>\n        let\n            Query = [limit = "200"]\n                & (if cursor = null then [] else [cursor = cursor]),\n            Answer = Json.Document(Web.Contents(BaseUrl, [\n                RelativePath = "api/v1/external/fabric/" & Dataset & "/records",\n                Query = Query,\n                Headers = [Authorization = "Bearer " & FabricToken, Accept = "application/json"]\n            ]))\n        in\n            Answer,\n    Pages = List.Generate(\n        () => GetPage(null),\n        (page) => page <> null,\n        (page) => if page[pagination][hasMore] then GetPage(page[pagination][nextCursor]) else null,\n        (page) => List.Transform(page[items], each [values])\n    ),\n    Rows = List.Combine(Pages),\n    Result = Table.FromRecords(Rows, null, MissingField.UseNull)\nin\n    Result`;
    const n8n = `Node:    HTTP Request\nMethod:  GET\nURL:     ${base}/sales/records\n\nAuthentication:  Generic Credential Type → Header Auth\n  Name:   Authorization\n  Value:  Bearer paste-your-token-here   (kept in n8n's encrypted credentials)\n\nSend Query Parameters:\n  dateFrom = 2026-01-01\n  dateTo   = 2026-01-31\n  limit    = 200\n\nOptions → Pagination:\n  Pagination Mode:   Update a Parameter in Each Request\n  Type: Query   Name: cursor\n  Value: {{ $response.body.pagination.nextCursor }}\n  Pagination Complete When: Other\n  Complete Expression: {{ !$response.body.pagination.hasMore }}`;
    const automate = `{\n  "type": "Http",\n  "inputs": {\n    "method": "GET",\n    "uri": "${base}/inventory/records",\n    "queries": {\n      "limit": "200",\n      "cursor": "@{variables('cursor')}"\n    },\n    "headers": {\n      "Authorization": "Bearer @{parameters('JarcFabricToken')}"\n    }\n  }\n}\n// Loop with "Do until" while body('HTTP')?['pagination']?['hasMore'] is true,\n// setting the cursor variable to body('HTTP')?['pagination']?['nextCursor'].\n// Leave "cursor" out of the first request (or send it empty only if your flow removes empty values).\n// Keep the token in a secure parameter or Azure Key Vault, never in the flow's plain text.`;
    const schema = `{\n  "dataset": "inventory",\n  "label": "Inventory",\n  "fields": [\n    { "name": "FIELD_A", "type": "date", "filterable": true, "sortable": true, "searchable": false },\n    { "name": "FIELD_B", "type": "string", "filterable": false, "sortable": false, "searchable": true }\n  ],\n  "filters": "allow-listed equality filters, by API name",\n  "sorts": "allow-listed sorts, by API name",\n  "defaultColumns": ["FIELD_A", "FIELD_B"],\n  "dateField": "FIELD_A",\n  "recordKey": ["FIELD_B"]\n}`;
    const example = `{\n  "items": [\n    { "id": "RECORD_ID", "values": { "FIELD_A": "2026-01-15T00:00:00.000Z", "FIELD_B": "EXAMPLE" } }\n  ],\n  "pagination": { "limit": 200, "hasMore": true, "nextCursor": "OPAQUE_CURSOR" },\n  "window": { "dateFrom": "2026-01-01", "dateTo": "2026-01-31" }\n}`;
    const errors = `{\n  "error": {\n    "code": "FABRIC_RANGE_TOO_LARGE",\n    "message": "Narrow the date range or choose a company."\n  }\n}`;
    return `<article class="apitok-docs fabric-docs">
      <h3>Getting started</h3>
      <p>The Fabric API lets Power BI, Power Automate, n8n and your own scripts read the <strong>Sales</strong> and <strong>Inventory</strong> datasets a token was given. It is <strong>read-only</strong>: there is nothing it can create, change or delete.</p>
      <dl class="apitok-facts"><div><dt>Base URL</dt><dd>${c(base)}</dd></div><div><dt>Authentication</dt><dd>${c("Authorization: Bearer JARC_FABRIC_TOKEN")}</dd></div><div><dt>Format</dt><dd>JSON over HTTPS, GET only</dd></div><div><dt>Datasets</dt><dd>${c("sales")}, ${c("inventory")}</dd></div></dl>
      <p>Send the token only in the ${c("Authorization")} header; a token in the URL is refused. Fabric tokens can't read boards, and board tokens can't read Fabric Data. A token stops working as soon as its owner loses Fabric Data access.</p>
      <h3>Scopes</h3>
      ${table(["Scope", "What it allows"], [
        [c("fabric.sales.read"), `Read the ${c("sales")} dataset.`],
        [c("fabric.inventory.read"), `Read the ${c("inventory")} dataset.`],
        [c("fabric.sensitive.read"), "Also return the sensitive (cost and price) fields of the datasets above. Only together with a dataset scope, granted only by an administrator who may see those fields, and only while the token's owner still may."]
      ])}
      <p>A request for a dataset the token wasn't given answers ${c("403 INSUFFICIENT_SCOPE")}. Without the sensitive scope, sensitive fields are simply absent: from the schema, the rows and the records, and they can't be named as a field, filter, sort or search.</p>
      <h3>Endpoints</h3>
      ${table(["Request", "What it returns"], [
        [c("GET /status"), "Whether Fabric Data is available, the datasets this token can read and each one's state (latest date, whether indexes are missing), and the limits."],
        [c("GET /{dataset}/schema"), `The fields this token may read (name and type, and which can be filtered, sorted or searched), the allow-listed ${c("filters")} and ${c("sorts")}, ${c("defaultColumns")}, ${c("dateField")} and ${c("recordKey")}.`],
        [c("GET /{dataset}/records"), `One page of rows: ${c("{ items: [{ id, values }], pagination, window }")}. Query: ${c("dateFrom")}, ${c("dateTo")} (YYYY-MM-DD, UTC days; without them the server uses its default window, the 30 days up to the dataset's latest date), ${c("company")} (${c("~")} = no company), ${c("q")} (search), any filter the schema lists, ${c("sort")} (a name from the schema), ${c("dir")} (${c("asc|desc")}), ${c("limit")} (1–200, 100 by default), ${c("cursor")}, ${c("fields")} (a comma list from the schema; the default columns otherwise). No totals are returned.`],
        [c("GET /{dataset}/records/{id}"), `One record with every field the token may read: ${c("{ record: { id, key, fields: [{ name, value, type }] } }")}.`]
      ])}
      <h3>Identifiers and paging</h3>
      <ul><li>Paging uses an opaque ${c("pagination.nextCursor")}. Send it back unchanged as ${c("cursor")} with the same filters while ${c("pagination.hasMore")} is true.</li>
      <li>Record IDs aren't permanent: they change when the data is reloaded upstream. Don't store them; a stale ID answers ${c("404 FABRIC_RECORD_NOT_FOUND")}. Use the dataset's ${c("recordKey")} fields to identify a row in your own system.</li>
      <li>The date span of one request is limited (see ${c("/status")}); read longer periods in several windows.</li>
      <li>Exact decimals can be strings (for example ${c('"10.00"')}); dates are ISO 8601 strings in UTC.</li></ul>
      <h3>Rate limits</h3>
      <p>Each token may make a set number of requests per minute: the ${c("X-RateLimit-Limit")} and ${c("X-RateLimit-Remaining")} headers say how many. Short bursts are limited as well, and a token may run only a few requests at the same time. A ${c("429 RATE_LIMITED")} answer has a ${c("Retry-After")} header: wait that many seconds. Fetch pages one after another rather than in parallel.</p>
      <h3>Examples</h3>
      ${code("curl", "curl", curl)}
      ${code("m", "Power BI (Power Query M) — all pages with List.Generate", m)}
      ${code("n8n", "n8n — HTTP Request node with pagination", n8n)}
      ${code("automate", "Power Automate — HTTP action", automate)}
      <h3>Example answers</h3>
      ${code("schema", "GET /inventory/schema (shape, placeholder names)", schema)}
      ${code("example", "GET /sales/records (placeholder values)", example)}
      <h3>Errors</h3>
      ${code("errors", "Error shape", errors)}
      ${table(["Status", "Code", "Meaning"], [
        ["400", c("VALIDATION_ERROR"), "A parameter is missing, repeated, unknown, not allowed or out of range."],
        ["401", c("UNAUTHENTICATED"), "No token, or the token isn't valid."],
        ["403", c("INSUFFICIENT_SCOPE"), "Not a Fabric token, or the dataset isn't among its scopes."],
        ["403", c("TOKEN_ACCESS_REVOKED"), "The token's owner no longer has Fabric Data access."],
        ["404", c("NOT_FOUND"), "Not a dataset of this API."],
        ["404", c("FABRIC_RECORD_NOT_FOUND"), "The record is no longer in the source (it may have been refreshed). Read the rows again."],
        ["422", c("FABRIC_RANGE_TOO_LARGE"), "Too many rows: narrow the date range or choose a company."],
        ["429", `${c("RATE_LIMITED")}, ${c("FABRIC_BUSY")}`, `Too many requests, or too many at once: wait for ${c("Retry-After")} seconds.`],
        ["503", `${c("FABRIC_UNAVAILABLE")}, ${c("FABRIC_SOURCE_MISSING")}, ${c("FABRIC_INDEX_REQUIRED")}, ${c("FABRIC_TIMEOUT")}`, "Fabric Data is unreachable, being refreshed upstream, waiting for the data team to add indexes, or the request took too long."]
      ])}
    </article>`;
  }
};
