// TEST-ONLY mock of monday.com: the OAuth token endpoint and the GraphQL API (https://api.monday.com/v2), as a fetch
// function. Every other URL is refused and recorded, so code under test can never reach the real monday.com.
const crypto = require("crypto");

const SIGNING = "test-signing-secret";
const ENV = { MONDAY_INTEGRATION_ENABLED: "true", MONDAY_CLIENT_ID: "test-client-id", MONDAY_CLIENT_SECRET: "test-client-secret", MONDAY_REDIRECT_URI: "http://localhost/api/v1/integrations/monday/callback", MONDAY_TOKEN_KEY: crypto.randomBytes(32).toString("base64"), MONDAY_SIGNING_SECRET: SIGNING };
const ACCESS_TOKEN = "mock-access-token-123";

const STATUS_SETTINGS = JSON.stringify({ labels: { 0: "Working on it", 1: "Done", 2: "Stuck" }, labels_colors: { 0: { color: "#fdab3d" }, 1: { color: "#00c875" }, 2: { color: "#e2445c" } } });
const COLUMNS = [
  { id: "name", title: "Name", type: "name", settings_str: "{}" },
  { id: "status", title: "Status", type: "status", settings_str: STATUS_SETTINGS },
  { id: "numbers", title: "Budget", type: "numbers", settings_str: "{}" },
  { id: "date4", title: "Due", type: "date", settings_str: "{}" },
  { id: "person", title: "Owner", type: "people", settings_str: "{}" },
  { id: "files", title: "Files", type: "file", settings_str: "{}" }
];
const item = (n, extra = {}) => ({ id: String(9000 + n), name: `Item ${n}`, updated_at: "2026-10-01T10:00:00Z", state: "active", group: { id: n % 2 ? "g1" : "g2", title: "" },
  column_values: [{ id: "status", type: "status", text: n % 3 ? "Done" : "Working on it", value: null }, { id: "numbers", type: "numbers", text: String(n * 10), value: `"${n * 10}"` }, { id: "date4", type: "date", text: "2026-11-05", value: JSON.stringify({ date: "2026-11-05" }) }, { id: "person", type: "people", text: "Ada, Bo", value: null }, { id: "files", type: "file", text: "a.pdf", value: null }], ...extra });

// The mock monday.com. `items` is the board's current content; failures can be queued.
function mockMonday() {
  const m = { items: Array.from({ length: 230 }, (_, i) => item(i + 1)), queries: [], tokenCalls: [], fail: [], tokenOk: true, outside: [] };
  m.fetch = async (url, init = {}) => {
    const u = String(url);
    const json = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body });
    if (u === "https://auth.monday.com/oauth2/token") { m.tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body))); return m.tokenOk ? json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer" }) : json(400, { error: "invalid_grant" }); }
    if (u !== "https://api.monday.com/v2") { m.outside.push(u); throw new Error(`mock monday: refused ${u}`); }
    const { query, variables } = JSON.parse(init.body);
    m.queries.push({ query, variables, auth: init.headers.Authorization, version: init.headers["API-Version"] || null });
    const f = m.fail.shift();
    if (f === "network") throw new TypeError("fetch failed");
    if (f === 429) return json(429, { errors: [{ message: "Rate limit exceeded" }] }, { "retry-after": "1" });
    if (f === "complexity") return json(200, { errors: [{ message: "Complexity budget exhausted", extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED", retry_in_seconds: 2 } }] });
    if (f === 401) return json(401, { errors: [{ message: "Not Authenticated", extensions: { code: "USER_UNAUTHORIZED" } }] });
    if (f === 500) return json(500, null);
    if (init.headers.Authorization !== ACCESS_TOKEN) return json(401, { errors: [{ message: "Not Authenticated" }] });
    const page = (from) => { const items = m.items.slice(from, from + variables.limit); return { cursor: from + variables.limit < m.items.length ? `cur-${from + variables.limit}` : null, items }; };
    if (/\bme \{/.test(query)) return json(200, { data: { me: { id: "1", name: "Test Admin", email: "admin@example.invalid", account: { id: "77", name: "Mock Account", slug: "mock" } } } });
    if (/workspaces\(/.test(query)) return json(200, { data: { workspaces: variables.page === 1 ? [{ id: "5", name: "Operations", kind: "open" }] : [] } });
    if (/next_items_page/.test(query)) return json(200, { data: { next_items_page: page(Number(variables.cursor.slice(4))) } });
    if (/items_page/.test(query)) return json(200, { data: { boards: [{ items_page: page(0) }] } });
    if (/columns \{/.test(query)) return json(200, { data: { boards: variables.ids[0] === "111" ? [{ id: "111", name: "Projects", description: "From monday", workspace_id: "5", items_count: m.items.length, columns: COLUMNS, groups: [{ id: "g1", title: "Active" }, { id: "g2", title: "Done" }] }] : [] } });
    if (/boards\(limit/.test(query)) return json(200, { data: { boards: variables.page === 1 ? [{ id: "111", name: "Projects", type: "board", workspace_id: "5", items_count: m.items.length }, { id: "112", name: "Subitems of Projects", type: "sub_items_board" }] : [] } });
    if (/items\(ids/.test(query)) { const found = m.items.find((i) => i.id === variables.ids[0]); return json(200, { data: { items: found ? [{ ...found, board: { id: "111" } }] : [] } }); }
    return json(200, { errors: [{ message: "mock: unknown query" }] });
  };
  return m;
}

module.exports = { mockMonday, item, COLUMNS, ENV, SIGNING, ACCESS_TOKEN };
