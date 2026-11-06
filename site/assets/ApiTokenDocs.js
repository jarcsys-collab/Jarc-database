// Developer → Documentation. Text only: placeholders stand in for every secret, and the base URL is this server's own.
// Every path and field here is checked against the real API by server/tests/api-tokens.test.js.
const ApiTokenDocs = {
  html(esc, base) {
    const api = `${base}/api/v1/external`;
    const code = (id, label, text) => `<figure class="apitok-code"><figcaption><span>${esc(label)}</span><button type="button" class="button secondary" data-action="apitok-copy-example" data-example="${id}">Copy</button></figcaption><pre id="apitok-example-${id}" tabindex="0"><code>${esc(text)}</code></pre></figure>`;
    const row = (cells) => `<tr>${cells.map((c, i) => `<td${i === 0 ? ' class="apitok-nowrap"' : ""}>${c}</td>`).join("")}</tr>`;
    const table = (head, rows) => `<div class="apitok-table-scroll" tabindex="0"><table class="apitok-doc-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(row).join("")}</tbody></table></div>`;
    const c = (t) => `<code>${esc(t)}</code>`;
    const curl = `# Set the token in your shell first, so it isn't saved in your scripts:\n#   export JARC_API_TOKEN="paste-your-token-here"\ncurl -H "Authorization: Bearer $JARC_API_TOKEN" \\\n  "${api}/boards/BOARD_ID/records?limit=500"`;
    const js = `// Run this on your server. Never put a token in a web page or public JavaScript.\nconst BASE = "${api}";\nconst headers = { Authorization: \`Bearer \${process.env.JARC_API_TOKEN}\` };\n\nasync function allRecords(boardId) {\n  const records = [];\n  let cursor = null;\n  do {\n    const url = new URL(\`\${BASE}/boards/\${boardId}/records\`);\n    url.searchParams.set("limit", "500");\n    if (cursor) url.searchParams.set("cursor", cursor);\n    const response = await fetch(url, { headers });\n    if (response.status === 429) {\n      const wait = Number(response.headers.get("retry-after")) || 60;\n      await new Promise((resolve) => setTimeout(resolve, wait * 1000));\n      continue;\n    }\n    const body = await response.json();\n    if (!response.ok) throw new Error(\`\${body.error.code}: \${body.error.message}\`);\n    records.push(...body.items);\n    cursor = body.pagination.nextCursor;\n  } while (cursor);\n  return records;\n}`;
    const m = `// In Power BI: Get data → Blank query → Advanced editor.\n// Store the token in a parameter named JarcToken, and when asked for credentials choose Anonymous.\nlet\n    BaseUrl = "${base}",\n    BoardId = "BOARD_ID",\n    Call = (path as text, query as record) =>\n        Json.Document(Web.Contents(BaseUrl, [\n            RelativePath = "api/v1/external/" & path,\n            Query = query,\n            Headers = [Authorization = "Bearer " & JarcToken, Accept = "application/json"]\n        ])),\n    Columns = Call("boards/" & BoardId & "/columns", [])[items],\n    GetPage = (cursor as nullable text) =>\n        Call("boards/" & BoardId & "/records", [limit = "500"] & (if cursor = null then [] else [cursor = cursor])),\n    Pages = List.Generate(\n        () => GetPage(null),\n        (page) => page <> null,\n        (page) => if page[pagination][nextCursor] = null then null else GetPage(page[pagination][nextCursor])\n    ),\n    Records = List.Combine(List.Transform(Pages, each _[items])),\n    AsTable = Table.FromRecords(Records, {"id", "groupId", "createdAt", "updatedAt", "values"}, MissingField.UseNull),\n    Keys = List.Transform(Columns, each _[id]),\n    Labels = List.Transform(Columns, each _[name]),\n    Expanded = Table.ExpandRecordColumn(AsTable, "values", Keys, Labels)\nin\n    Expanded`;
    const automate = `{\n  "type": "Http",\n  "inputs": {\n    "method": "GET",\n    "uri": "${api}/boards/BOARD_ID/records",\n    "queries": {\n      "limit": "500",\n      "cursor": "@{variables('cursor')}"\n    },\n    "headers": {\n      "Authorization": "Bearer @{parameters('JarcApiToken')}"\n    }\n  }\n}`;
    const n8n = `Method:  GET\nURL:     ${api}/boards/BOARD_ID/records\n\nAuthentication:  Generic Credential Type → Header Auth\n  Name:   Authorization\n  Value:  Bearer paste-your-token-here   (saved in n8n's encrypted credentials)\n\nSend Query Parameters:\n  limit = 500\n\nOptions → Pagination:\n  Pagination Mode:   Update a Parameter in Each Request\n  Type: Query   Name: cursor\n  Value:             {{ $response.body.pagination.nextCursor }}\n  Pagination Complete When:  Other\n  Complete Expression:       {{ $response.body.pagination.nextCursor === null }}`;
    const example = `{\n  "items": [\n    {\n      "id": "665f0c2a9b1e8a0012ab34cd",\n      "workspaceId": "665f0c2a9b1e8a0012ab3400",\n      "boardId": "665f0c2a9b1e8a0012ab3411",\n      "groupId": "group-1",\n      "position": 1000,\n      "archived": false,\n      "values": { "serial": "Example item", "status": "Done", "amount": 125 },\n      "createdAt": "2026-01-15T09:30:00.000Z",\n      "updatedAt": "2026-02-01T14:05:12.000Z",\n      "version": 3\n    }\n  ],\n  "pagination": {\n    "limit": 100,\n    "hasMore": true,\n    "nextCursor": "eyJiIjoiNjY1ZjBjMmE5YjFl..."\n  }\n}`;
    const valuesExample = `{\n  "items": [\n    {\n      "boardId": "665f0c2a9b1e8a0012ab3411",\n      "columnId": "status",\n      "columnName": "Status",\n      "columnType": "status",\n      "recordId": "665f0c2a9b1e8a0012ab34cd",\n      "value": "Done",\n      "updatedAt": "2026-02-01T14:05:12.000Z"\n    }\n  ],\n  "pagination": { "limit": 100, "hasMore": false, "nextCursor": null }\n}`;
    const errors = `{\n  "error": {\n    "code": "TOKEN_EXPIRED",\n    "message": "This API token has expired. Create or rotate a token in JARC."\n  }\n}`;
    return `<article class="apitok-docs">
      <h3>Getting started</h3>
      <p>The JARC API lets other systems read the boards you choose. It is read-only: nothing it does can change your data.</p>
      <dl class="apitok-facts"><div><dt>Base URL</dt><dd>${c(api)}</dd></div><div><dt>Authentication</dt><dd>${c("Authorization: Bearer JARC_API_TOKEN")}</dd></div><div><dt>Format</dt><dd>JSON over HTTPS</dd></div></dl>
      <p>A token is accepted only in the ${c("Authorization")} header. A token in the URL is refused, because URLs end up in logs and browser history.</p>

      <h3>Who can create a token</h3>
      <p>Any employee with their own membership of a workspace, Viewer or above, can create read-only tokens for it under <strong>Developer → API Tokens</strong>. Shared or beta access and administrator roles don't count on their own: you need a real membership. A token is limited to one workspace and the boards you select, and it can never see more than you can.</p>
      <p>One token reads every board you selected, and every column on those boards: you don't need a token per board or per column. Boards created later aren't added to an existing token; rotate it or create a new one to include them. Each token is personal: don't share it, create one per integration instead.</p>
      <p>JARC checks your access on every request. If your membership is removed or your account is disabled, your tokens stop working at once. You can always revoke your own tokens while you can sign in, even with no membership left.</p>

      <h3>Board and column IDs</h3>
      <p>Every board and column has a permanent ID, the same for everyone in the company. Copy a board's from its menu and a column's from its header menu (each also has <strong>API Information</strong>), or look them up under <strong>Developer → Boards &amp; Columns</strong>. An ID stays the same when something is renamed, moved, reordered or hidden, and isn't used again after deletion. A column ID is unique within its board, so identify a column by its board ID and column ID together.</p>
      <p>IDs aren't secrets, and knowing one grants nothing. The token is what authorises a request, and it must cover the board.</p>

      <h3>Endpoints</h3>
      ${table(["Request", "Returns"], [
        [c("GET /me"), "This token's name, scope and expiry"],
        [c("GET /workspaces"), "The token's workspace"],
        [c("GET /workspaces/:workspaceId/boards"), "The boards this token can read, with record counts"],
        [c("GET /boards/:boardId"), "One board with its columns and groups"],
        [c("GET /boards/:boardId/columns"), "Each column's ID, name, type, options and order"],
        [c("GET /boards/:boardId/columns/:columnId"), "One column"],
        [c("GET /boards/:boardId/columns/:columnId/values"), "A page of one column's values"],
        [c("GET /boards/:boardId/groups"), "Group ID, name, colour and order"],
        [c("GET /boards/:boardId/records"), "A page of records"],
        [c("GET /boards/:boardId/records/:recordId/columns/:columnId"), "One column's value on one record"],
        [c("GET /records/:recordId"), "One record"]
      ])}
      <p>Hiding a column only changes how the board looks: hidden columns are still returned, marked ${c("visible: false")}. Anything outside the token's scope answers ${c("404")}. Archived workspaces, boards and records also answer ${c("404")}, or are left out of lists, unless you add ${c("includeArchived=true")} to the request. File contents aren't available through this API. People columns return JARC user IDs such as ${c("user:665f…")}.</p>

      <h3>Example request and response</h3>
      ${code("curl", "cURL", curl)}
      ${code("response", "Response", example)}
      <p>Record ${c("values")} are keyed by column ID, with every column present. Use ${c("/columns")} to turn IDs into names.</p>
      <h4>Selected columns</h4>
      <p>Add ${c("columns")} to get only the columns you need. The records keep the same shape.</p>
      ${code("selected", "Only two columns", `curl -H "Authorization: Bearer $JARC_API_TOKEN" \\\n  "${api}/boards/BOARD_ID/records?columns=COLUMN_ID_1,COLUMN_ID_2"`)}
      <h4>One column</h4>
      <p>${c("/columns/:columnId/values")} takes the same paging and filters as records, and returns one entry per record. ${c("/records/:recordId/columns/:columnId")} returns one such entry as ${c("value")}.</p>
      ${code("values", "Response", valuesExample)}
      <h4>How values are returned</h4>
      <p>Values come back as JARC stores them, with their JSON type: numbers and checkboxes as numbers and booleans; text, email, phone, links, dates (${c("YYYY-MM-DD")}), status and single-choice dropdowns as text; dropdowns allowing several values and People as lists. A value that was never set is ${c("null")}, and a cleared one can be an empty string, so check for both. The board's Group column returns the group's name, or ${c("null")}.</p>

      <h3>Pagination</h3>
      <p>Records come in pages: 100 by default and at most 500 (${c("limit")}). While ${c("pagination.nextCursor")} isn't ${c("null")}, send it back as ${c("cursor")} with the same filters to get the next page.</p>
      ${table(["Parameter", "Meaning"], [
        [c("limit"), "Records per page, 1 to 500"],
        [c("cursor"), "The ${nextCursor} of the previous page".replace("${nextCursor}", c("nextCursor"))],
        [c("columns"), `Column IDs separated by commas (records only)`],
        [c("groupId"), `Only this group (${c("none")} for records without a group)`],
        [c("includeArchived"), `${c("true")} also returns archived records, with ${c("archived: true")}. Every read request accepts it, and it is also how you reach an archived board or workspace.`],
        [c("updatedSince"), `Only records changed at or after this time, such as ${c("2026-01-31T12:00:00Z")}`]
      ])}
      <p>Without ${c("updatedSince")}, records come in a fixed order by ID, so a complete read returns each record once even while people are working on the board. A record added during the read appears on a later page.</p>
      <h4>Keeping a copy up to date</h4>
      <p>Save the time you start each sync and pass it as ${c("updatedSince")} next time. Records then come in order of their last change. One edited during the read can appear twice, so keep the last copy of each ${c("id")}. Records older than JARC's own change tracking may have no ${c("updatedAt")} and only appear in a complete read. Deleted records simply stop appearing, so run a complete read from time to time to remove them from your copy.</p>

      <h3>Rate limits</h3>
      <p>Each token has its own limit, 120 requests per minute unless your administrator has changed it. Every response has ${c("X-RateLimit-Limit")}, ${c("X-RateLimit-Remaining")} and ${c("X-RateLimit-Reset")} (seconds). Over the limit you get ${c("429")} with ${c("Retry-After")}: wait that many seconds and try again.</p>

      <h3>Expiry, rotation and revocation</h3>
      <ul><li>Every token has an expiry date, at most 366 days away. After it, requests get ${c("TOKEN_EXPIRED")}.</li>
      <li><strong>Rotate</strong> creates a replacement with the same boards. The old token keeps working for the overlap you choose (up to 7 days), so you can update the integration without an outage. Your other tokens aren't affected.</li>
      <li><strong>Revoke</strong> ends a token immediately and can't be undone. You can always revoke your own tokens.</li>
      <li>The full token is shown once, when it is created. JARC stores only a keyed digest, so nobody can show it again. If you lose it, rotate.</li></ul>

      <h3>Common errors</h3>
      ${code("errors", "Every error has this shape", errors)}
      ${table(["Status", "Code", "What to do"], [
        ["400", c("VALIDATION_ERROR"), "A parameter or ID isn't valid. The message says which."],
        ["400", c("TOKEN_IN_QUERY"), "Move the token to the Authorization header, and revoke it if the URL was shared."],
        ["401", c("UNAUTHENTICATED"), "Send the Authorization header."],
        ["401", c("INVALID_TOKEN"), "Check that the token was copied completely."],
        ["401", c("TOKEN_EXPIRED"), "Rotate the token or create a new one."],
        ["401", c("TOKEN_REVOKED"), "Create a new token."],
        ["403", c("TOKEN_ACCESS_REVOKED"), "The token's creator no longer has access to the workspace."],
        ["403", c("TOKEN_OWNER_DISABLED"), "The token's creator can no longer use JARC."],
        ["403", c("HTTPS_REQUIRED"), "Use an https:// address."],
        ["404", c("NOT_FOUND"), "It doesn't exist, or it is outside this token's scope."],
        ["405", c("METHOD_NOT_ALLOWED"), "The API is read-only: use GET."],
        ["429", c("RATE_LIMITED"), "Wait for the time in Retry-After."],
        ["503", c("SERVICE_UNAVAILABLE"), "Try again shortly."]
      ])}

      <h3>Security recommendations</h3>
      <ul><li>Treat a token like a password. Keep it in a secure backend or an approved secret store, such as your platform's encrypted credentials.</li>
      <li><strong>Never put a token in public JavaScript, a web page, a mobile app or a shared file.</strong> Anyone who can see it can read the token's boards.</li>
      <li>Don't send tokens by email or chat, and don't commit them to source control.</li>
      <li>Use one token per integration, with only the boards it needs and the shortest practical expiry.</li>
      <li>Revoke any token you think has been exposed, and check “Last used” for tokens you don't recognise.</li></ul>

      <h3>Integration examples</h3>
      <p>Replace ${c("BOARD_ID")} with an ID from ${c("GET /workspaces/:workspaceId/boards")}.</p>
      <h4>Power BI and Excel (Power Query M)</h4>
      ${code("m", "Power Query M", m)}
      <h4>Power Automate (HTTP action)</h4>
      <p>Initialise a string variable ${c("cursor")}, then repeat this action in a <em>Do until</em> loop. After each call, set ${c("cursor")} to ${c("body('HTTP')?['pagination']?['nextCursor']")}, and stop when it is ${c("null")}. An empty ${c("cursor")} asks for the first page. Keep the token in a secure environment variable or Azure Key Vault, and turn on Secure Inputs and Outputs for the action.</p>
      ${code("automate", "Action definition", automate)}
      <h4>n8n (HTTP Request node)</h4>
      ${code("n8n", "Node settings", n8n)}
      <h4>JavaScript fetch, from a secure backend</h4>
      ${code("js", "Node.js", js)}
      <h4>cURL</h4>
      ${code("curl2", "cURL, for one board's columns", `curl -H "Authorization: Bearer $JARC_API_TOKEN" \\\n  "${api}/boards/BOARD_ID/columns"`)}
    </article>`;
  }
};

window.ApiTokenDocs = ApiTokenDocs;
