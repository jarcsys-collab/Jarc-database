// Fabric Data → API Management → Documentation. Text only: placeholders stand in for every key and value (never real data), and
// the base URL is this server's own. Paths, response shapes and error codes are the ones the server actually sends
// (server/src/routes/external-fabric.js, external-api.js readOnlyGuard/bearerToken, ApiTokenService.verify,
// FabricTokenService.authorize, fabric/router.js, fabric/errors.js, fabric/validation.js): the Sales and Inventory datasets only.
const FabricApiDocs = {
  // The restricted fields of each dataset (fabric/datasets.js `sensitive`): returned only with fabric.sensitive.read AND while the
  // key's owner may still read sensitive fields. Field names only; never their values.
  RESTRICTED: Object.freeze({
    sales: Object.freeze(["landed_cost", "Text", "Custom", "custom_1", "Custom.2"]),
    inventory: Object.freeze(["Cost_Amount_Expected", "Cost_Amount_Actual", "Cost_Amount_Non_Invtbl", "Cost_Amount_Expected_ACY", "Cost_Amount_Actual_ACY", "Cost_Amount_Non_Invtbl_ACY", "landed_cost", "distributors_price", "trade_price"])
  }),
  // [status, code(s), meaning]: every refusal the external Fabric API can answer, in the order they are checked.
  ERRORS: Object.freeze([
    ["400", ["TOKEN_IN_QUERY"], "A key (or something that looks like one) was sent in the URL. Send it only in the Authorization header, and revoke a key that has been shared this way."],
    ["400", ["VALIDATION_ERROR"], "A parameter is missing, repeated, unknown, not allowed or out of range: for example limit outside 1–200, a Sales date range over 92 days, a field, filter or sort that isn't in the schema (a restricted field without the sensitive scope counts as unknown), or a cursor that is invalid or no longer valid (start again from the first page)."],
    ["401", ["UNAUTHENTICATED"], "No Authorization header."],
    ["401", ["INVALID_TOKEN"], "The header isn't \"Bearer <key>\", or the key doesn't exist or its secret is wrong."],
    ["401", ["TOKEN_REVOKED"], "The key was revoked. Create a new one."],
    ["401", ["TOKEN_EXPIRED"], "The key's expiry date has passed. Create a new one."],
    ["403", ["INSUFFICIENT_SCOPE"], "Not a Fabric key (board keys can't read Fabric Data), or the dataset isn't among the key's scopes."],
    ["403", ["TOKEN_ACCESS_REVOKED", "TOKEN_OWNER_DISABLED"], "The key's owner can no longer read Fabric Data, or can no longer use JARC."],
    ["403", ["HTTPS_REQUIRED"], "The request used http://. Use https://."],
    ["404", ["NOT_FOUND"], "Not a dataset or path of this API. The name you sent is never repeated back."],
    ["404", ["FABRIC_RECORD_NOT_FOUND"], "The record is no longer in the source (it may have been refreshed). Read the rows again."],
    ["405", ["METHOD_NOT_ALLOWED"], "Anything other than GET or HEAD. The Allow header says GET, HEAD."],
    ["422", ["FABRIC_RANGE_TOO_LARGE"], "Too many rows: narrow the date range or add a company filter."],
    ["429", ["RATE_LIMITED"], "Over the key's requests per minute or the short-burst limit (wait for the Retry-After seconds), or too many failed attempts from your address (wait a minute)."],
    ["503", ["FABRIC_BUSY"], "Too many requests from this key at the same time, or Fabric Data is busy. Wait for the Retry-After seconds and send requests one after another."],
    ["503", ["FABRIC_UNAVAILABLE", "FABRIC_SOURCE_MISSING", "FABRIC_INDEX_REQUIRED", "FABRIC_TIMEOUT", "FABRIC_UNSAFE_CREDENTIALS"], "Fabric Data can't be reached, is being refreshed upstream, needs a database index the data team hasn't added yet, took too long (narrow the request), or is switched off for safety. Try again later."]
  ]),
  html(esc, origin) {
    const base = `${origin}/api/v1/external/fabric`;
    const code = (id, label, text) => `<figure class="fx-api-code apitok-code"><figcaption><span>${esc(label)}</span><button type="button" class="fx-btn fx-btn--sm" data-action="fabric-api-copy-example" data-example="${id}">Copy</button></figcaption><pre id="fabric-api-example-${id}" tabindex="0"><code>${esc(text)}</code></pre></figure>`;
    const c = (t) => `<code>${esc(t)}</code>`;
    const table = (label, head, rows) => `<div class="fx-grid fx-api-docs__grid" role="region" aria-label="${esc(label)}" tabindex="0"><table class="fx-grid__table fx-api-docs__table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((cell, i) => `<td${i === 0 ? ' class="fx-api-docs__nowrap"' : ""}>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const fieldList = (names) => names.map((n) => c(n)).join(", ");

    const curl = `# Keep the key in your shell, not in scripts:\n#   export FABRIC_API_KEY="<FABRIC_API_KEY>"\n\n# What the key can read, and each dataset's state:\ncurl -s -H "Authorization: Bearer $FABRIC_API_KEY" "${base}/status"\n\n# The fields, filters and sorts of a dataset (sales or inventory):\ncurl -s -H "Authorization: Bearer $FABRIC_API_KEY" "${base}/inventory/schema"\n\n# One page of rows (UTC days, at most 92 days for Sales; leave the dates out for the default window):\ncurl -s -H "Authorization: Bearer $FABRIC_API_KEY" \\\n  "${base}/sales/records?dateFrom=2026-06-01&dateTo=2026-06-30&limit=200"\n\n# Next page: the same request plus &cursor=<pagination.nextCursor from the previous answer>.\n# One record (every field the key may read):\ncurl -s -H "Authorization: Bearer $FABRIC_API_KEY" "${base}/sales/records/RECORD_ID"`;
    const m = `// Power BI: Get data → Blank query → Advanced editor.\n// First create a parameter named FabricToken (Manage Parameters → New) holding the key; never paste the key into the query text.\n// When asked for credentials, choose Anonymous: the key travels in the header.\nlet\n    Base   = "${origin}",\n    Key    = FabricToken,\n    Get    = (cursor as nullable text) =>\n        Json.Document(Web.Contents(Base, [\n            RelativePath = "api/v1/external/fabric/sales/records",\n            Query = [dateFrom = "2026-06-01", dateTo = "2026-06-30", limit = "200"]\n                    & (if cursor = null then [] else [cursor = cursor]),\n            Headers = [Authorization = "Bearer " & Key]\n        ])),\n    Pages  = List.Generate(\n        () => Get(null),\n        each _ <> null,\n        each if _[pagination][hasMore] then Get(_[pagination][nextCursor]) else null,\n        each _[items]),\n    Rows   = List.Combine(Pages),\n    Table  = Table.FromRecords(List.Transform(Rows, each Record.AddField([values], "id", [id])), null, MissingField.UseNull)\nin\n    Table`;
    const automate = `// 1. Initialize variable cursor (String, empty) and hasMore (Boolean, true).\n// 2. Do until hasMore is equal to false, with this HTTP action (code view).\n//    cursor is left out of the first request: it is added only once the variable has a value.\n{\n  "type": "Http",\n  "inputs": {\n    "method": "GET",\n    "uri": "${base}/inventory/records?limit=200@{if(empty(variables('cursor')),'',concat('&cursor=',encodeUriComponent(variables('cursor'))))}",\n    "headers": {\n      "Authorization": "Bearer @{parameters('FabricApiKey')}"\n    }\n  }\n}\n// 3. Parse JSON on body('HTTP'); Apply to each over body('HTTP')?['items'] (each row's fields: item()?['values']).\n// 4. Set variable hasMore = body('HTTP')?['pagination']?['hasMore']\n//    and cursor = body('HTTP')?['pagination']?['nextCursor'].\n// Keep the key in a secure parameter or environment variable and turn on Secure inputs.\n// Add a retry policy that respects 429 and 503 with Retry-After.`;
    const n8n = `Node:    HTTP Request\nMethod:  GET\nURL:     ${base}/sales/records\n\nAuthentication:  Generic Credential Type → Header Auth\n  Name:   Authorization\n  Value:  Bearer <FABRIC_API_KEY>   (kept in n8n's encrypted credentials)\n\nSend Query Parameters:\n  dateFrom = 2026-06-01\n  dateTo   = 2026-06-30\n  limit    = 200\n\nOptions → Pagination:\n  Pagination Mode:  Update a Parameter in Each Request\n  Type: Query   Name: cursor\n  Value: {{ $response.body.pagination.nextCursor }}\n  Pagination Complete When: Other\n  Complete Expression: {{ !$response.body.pagination.hasMore }}\n  Limit Pages Fetched: on;  Interval Between Requests: 1000 ms (stays under 60 per minute)\n\nThen a Split Out node on "items" gives one item per record.`;
    // Google Apps Script: the key and the base URL in Script Properties (never in the code or the URL), a schema test, then every
    // page of one explicit window (limit=200, cursor while hasMore), retrying 429 / 503 after Retry-After.
    const apps = `// Google Apps Script. Project Settings → Script Properties:\n//   FABRIC_API_KEY  = your Fabric API key (never in the code or in the URL)\n//   FABRIC_BASE_URL = ${base}\n// The base URL is a prefix: every call adds /{dataset}/schema or /{dataset}/records.\n\nfunction fabricGet_(path, params) {\n  const props = PropertiesService.getScriptProperties();\n  const key = props.getProperty("FABRIC_API_KEY");\n  const base = props.getProperty("FABRIC_BASE_URL");\n  if (!key || !base) throw new Error("Set FABRIC_API_KEY and FABRIC_BASE_URL in Script Properties.");\n  const query = Object.keys(params || {})\n    .map((name) => encodeURIComponent(name) + "=" + encodeURIComponent(params[name])).join("&");\n  const url = base.replace(/\\/+$/, "") + path + (query ? "?" + query : "");\n  for (let attempt = 1; ; attempt++) {\n    const response = UrlFetchApp.fetch(url, {\n      method: "get",\n      headers: { Authorization: "Bearer " + key },   // the key travels only in this header\n      muteHttpExceptions: true\n    });\n    const status = response.getResponseCode();\n    if (status === 200) return JSON.parse(response.getContentText());\n    if ((status === 429 || status === 503) && attempt < 5) {\n      const headers = response.getHeaders();\n      const wait = Number(headers["Retry-After"] || headers["retry-after"]) || attempt * 2;\n      Utilities.sleep(Math.min(wait, 60) * 1000);   // honour Retry-After, then try again\n      continue;\n    }\n    let error = {};\n    try { error = JSON.parse(response.getContentText()).error || {}; } catch (e) {}\n    throw new Error("Fabric API " + status + " " + (error.code || "") + ": " + (error.message || ""));\n  }\n}\n\n// 1. Connection test: the fields this key may read.\nfunction testFabricSchema() {\n  const schema = fabricGet_("/sales/schema");\n  Logger.log(schema.dataset + ": " + schema.fields.length + " fields, date field " + schema.dateField);\n}\n\n// 2. Every row of one window: UTC days, both inclusive, at most 92 days; 200 rows per page.\nfunction readFabricSales() {\n  const params = { dateFrom: "2026-06-01", dateTo: "2026-06-30", limit: "200" };\n  const rows = [];\n  let page;\n  do {\n    page = fabricGet_("/sales/records", params);\n    page.items.forEach((item) => rows.push(item.values));\n    params.cursor = page.pagination.nextCursor;   // same parameters + cursor for the next page\n  } while (page.pagination.hasMore);\n  Logger.log(rows.length + " rows, " + page.window.dateFrom + " to " + page.window.dateTo);\n  return rows;\n}`;
    const schema = `{\n  "dataset": "inventory",\n  "label": "Inventory",\n  "fields": [\n    { "name": "FIELD_A", "type": "date", "filterable": true, "sortable": true, "searchable": false },\n    { "name": "FIELD_B", "type": "string", "filterable": false, "sortable": false, "searchable": true }\n  ],\n  "filters": "allow-listed equality filters, by API name",\n  "sorts": "allow-listed sorts, by API name",\n  "defaultColumns": ["FIELD_A", "FIELD_B"],\n  "dateField": "FIELD_A",\n  "recordKey": ["FIELD_B"]\n}`;
    const page = `{\n  "dataset": "sales",\n  "fields": ["FIELD_A", "FIELD_B"],\n  "items": [\n    { "id": "RECORD_ID", "values": { "FIELD_A": "2026-06-15T00:00:00.000Z", "FIELD_B": "EXAMPLE" } }\n  ],\n  "pagination": { "limit": 200, "hasMore": true, "nextCursor": "OPAQUE_CURSOR" },\n  "window": { "field": "FIELD_A", "dateFrom": "2026-06-01", "dateTo": "2026-06-30", "defaulted": false },\n  "sort": { "name": "date", "dir": "desc" }\n}`;
    const record = `{\n  "record": {\n    "id": "RECORD_ID",\n    "key": { "FIELD_B": "EXAMPLE" },\n    "fields": [ { "name": "FIELD_A", "value": "2026-06-15T00:00:00.000Z", "type": "date" } ]\n  }\n}`;
    const errorShape = `{\n  "error": {\n    "code": "INVALID_TOKEN",\n    "message": "This API token isn't valid."\n  }\n}`;

    return `<article class="fx-api-docs apitok-docs fabric-docs">
      <section class="fx-api-docs__section"><h3>Getting started</h3>
      <p>The Fabric API lets Power BI, Power Automate, n8n and your own scripts read the <strong>Sales</strong> and <strong>Inventory</strong> datasets a key was given. It is <strong>read-only</strong>: there is nothing it can create, change or delete.</p>
      <dl class="fx-api-docs__facts"><div><dt>Base URL (prefix)</dt><dd>${c(base)}: not callable by itself (it answers 404). Add ${c("/{dataset}/schema")} or ${c("/{dataset}/records")}, for example ${c(`${base}/sales/records`)}.</dd></div><div><dt>Authentication</dt><dd>${c("Authorization: Bearer <FABRIC_API_KEY>")}</dd></div><div><dt>Format</dt><dd>JSON over HTTPS, GET only</dd></div><div><dt>Datasets</dt><dd>${c("sales")}, ${c("inventory")}</dd></div></dl>
      <p>Send the key only in the ${c("Authorization")} header: a key in the URL is refused (${c("400 TOKEN_IN_QUERY")}). Fabric keys can't read boards, and board keys can't read Fabric Data. A key stops working as soon as its owner loses Fabric Data access.</p></section>

      <section class="fx-api-docs__section"><h3>Scopes</h3>
      ${table("Scopes", ["Scope", "What it allows"], [
        [c("fabric.sales.read"), `Read the ${c("sales")} dataset.`],
        [c("fabric.inventory.read"), `Read the ${c("inventory")} dataset.`],
        [c("fabric.sensitive.read"), "Also return the restricted fields (below) of the datasets above. Only together with a dataset scope, and granted only by an administrator who may see those fields."]
      ])}
      <p>A request for a dataset the key wasn't given answers ${c("403 INSUFFICIENT_SCOPE")}.</p></section>

      <section class="fx-api-docs__section"><h3>Restricted fields</h3>
      <p>These fields are returned <strong>only</strong> when the key has ${c("fabric.sensitive.read")} <strong>and</strong> the key's owner still has the sensitive-fields permission at the time of the request. Otherwise they are absent from the schema, the rows and the records, and naming one as a field, filter, sort or search answers ${c("400 VALIDATION_ERROR")}, exactly like a field that doesn't exist.</p>
      ${table("Restricted fields", ["Dataset", "Restricted fields"], [
        [c("sales"), fieldList(FabricApiDocs.RESTRICTED.sales)],
        [c("inventory"), fieldList(FabricApiDocs.RESTRICTED.inventory)]
      ])}</section>

      <section class="fx-api-docs__section"><h3>Endpoints</h3>
      ${table("Endpoints", ["Request", "What it returns"], [
        [c("GET /status"), "Whether Fabric Data is available, the datasets this key can read and each one's state (latest date, whether indexes are missing), and the limits."],
        [c("GET /{dataset}/schema"), `The fields this key may read (name and type, and which can be filtered, sorted or searched), the allow-listed ${c("filters")} and ${c("sorts")}, ${c("defaultColumns")}, ${c("dateField")} and ${c("recordKey")}.`],
        [c("GET /{dataset}/records"), `One page of rows. Query: ${c("dateFrom")}, ${c("dateTo")} (YYYY-MM-DD, UTC days, both inclusive; without them the server uses its default window, the 30 days up to the dataset's latest date), ${c("company")} (${c("~")} = no company), ${c("q")} (search), any filter the schema lists, ${c("sort")} (a name from the schema), ${c("dir")} (${c("asc|desc")}), ${c("limit")} (1–200, 100 by default), ${c("cursor")}, ${c("fields")} (a comma list from the schema; the default columns otherwise). No totals are returned.`],
        [c("GET /{dataset}/records/{id}"), `One record with every field the key may read.`]
      ])}</section>

      <section class="fx-api-docs__section"><h3>Responses</h3>
      ${table("Response shapes", ["Request", "Shape"], [
        [c("/records"), `${c("items[]")} of ${c("{ id, values }")} (${c("values")} holds the requested fields by API name); ${c("pagination")} ${c("{ limit, hasMore, nextCursor }")}; ${c("window")} ${c("{ field, dateFrom, dateTo, defaulted }")} (${c("defaulted")} is true when the server chose the window; without a date window ${c("dateFrom")}/${c("dateTo")} are null and ${c("all")} is true); also ${c("dataset")}, ${c("fields")} and ${c("sort")}.`],
        [c("/records/{id}"), `${c("{ record: { id, key, fields: [{ name, value, type }] } }")}`]
      ])}
      ${code("page", "GET /sales/records (placeholder names and values)", page)}
      ${code("record", "GET /sales/records/{id} (placeholder names and values)", record)}
      ${code("schema", "GET /inventory/schema (shape, placeholder names)", schema)}</section>

      <section class="fx-api-docs__section"><h3>Identifiers and paging</h3>
      <ul><li>Paging uses an opaque ${c("pagination.nextCursor")}. Leave ${c("cursor")} out of the first request, then send ${c("nextCursor")} back unchanged as ${c("cursor")} with the same filters while ${c("pagination.hasMore")} is true. When it is false, ${c("nextCursor")} is null.</li>
      <li>A cursor is tied to its list and filters, and stops being valid when the server restarts: a refused cursor answers ${c("400 VALIDATION_ERROR")}; start again from the first page.</li>
      <li>Record IDs aren't permanent: they change when the data is reloaded upstream. Don't store them; a stale ID answers ${c("404 FABRIC_RECORD_NOT_FOUND")}. Use the dataset's ${c("recordKey")} fields to identify a row in your own system.</li>
      <li>One Sales request covers at most 92 days: read longer periods in 92-day slices.</li>
      <li>Exact decimals can be strings (for example ${c('"10.00"')}); dates are ISO 8601 strings in UTC.</li></ul></section>

      <section class="fx-api-docs__section"><h3>Rate limits</h3>
      <p>Each key may make 60 requests per minute unless your administrator set another limit: the ${c("X-RateLimit-Limit")}, ${c("X-RateLimit-Remaining")} and ${c("X-RateLimit-Reset")} headers say how many. Short bursts are limited as well, and a key may run only a few requests at the same time. A ${c("429 RATE_LIMITED")} or ${c("503 FABRIC_BUSY")} answer has a ${c("Retry-After")} header: wait that many seconds. Fetch pages one after another rather than in parallel.</p></section>

      <section class="fx-api-docs__section"><h3>Examples</h3>
      ${code("curl", "curl", curl)}
      ${code("m", "Power BI (Power Query M): all pages with List.Generate, the key in a parameter", m)}
      ${code("automate", "Power Automate: HTTP action in a Do until loop", automate)}
      ${code("n8n", "n8n: HTTP Request node with pagination", n8n)}
      ${code("apps", "Google Apps Script: key in Script Properties, schema test, every page with retries", apps)}</section>

      <section class="fx-api-docs__section"><h3>Errors</h3>
      <p>Every refusal has the same shape; ${c("error.message")} is safe to show and ${c("error.code")} is what to test for.</p>
      ${code("errors", "Error shape", errorShape)}
      ${table("Error codes", ["Status", "Code", "Meaning"], FabricApiDocs.ERRORS.map(([status, codes, meaning]) => [esc(status), codes.map((x) => c(x)).join(", "), esc(meaning)]))}</section>
    </article>`;
  }
};
