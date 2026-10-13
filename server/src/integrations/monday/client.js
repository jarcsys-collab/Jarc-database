// monday.com GraphQL API client (https://api.monday.com/v2). Read-only by design: it only ever sends queries, never
// mutations (JARC never writes to monday.com). The token is passed in by the server and never leaves it.
//
//   version   the API-Version header is sent only when configured (MONDAY_API_VERSION); without it monday.com uses
//             its "Current" version.
//   limits    complexity/rate-limit errors and HTTP 429/5xx are retried with backoff (honouring Retry-After or
//             retry_in_seconds); other errors are raised as MondayApiError with monday's error code.
//   paging    items: boards(ids){ items_page(limit){ cursor items } } then next_items_page(cursor) — items_page is
//             queried at the top level of the board (nesting it in groups multiplies complexity).
const API_URL = "https://api.monday.com/v2";

class MondayApiError extends Error {
  constructor(message, { status = 0, code = "MONDAY_ERROR", retryable = false } = {}) { super(message); this.name = "MondayApiError"; this.status = status; this.code = code; this.retryable = retryable; }
}

const ITEM_FIELDS = "id name updated_at state group { id title } column_values { id type text value }";

class MondayClient {
  constructor({ token, apiVersion = null, fetch: fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 4, timeoutMs = 30000 }) {
    if (!token) throw new MondayApiError("No monday.com access token.", { code: "NOT_CONNECTED" });
    Object.defineProperty(this, "token", { value: token, enumerable: false });
    Object.assign(this, { apiVersion, fetchImpl, sleep, maxRetries, timeoutMs });
  }

  async query(query, variables = {}) {
    if (/^\s*mutation\b/i.test(query)) throw new MondayApiError("JARC never sends changes to monday.com.", { code: "MUTATION_BLOCKED" });
    for (let attempt = 0; ; attempt += 1) {
      let res, body;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await this.fetchImpl(API_URL, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json", Authorization: this.token, ...(this.apiVersion ? { "API-Version": this.apiVersion } : {}) }, body: JSON.stringify({ query, variables }) });
        body = await res.json().catch(() => null);
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) { await this.sleep(this.backoff(attempt)); continue; }
        throw new MondayApiError("monday.com could not be reached.", { code: "NETWORK_ERROR", retryable: true });
      }
      clearTimeout(timer);
      const errors = body?.errors || (body?.error_code ? [{ message: body.error_message, extensions: { code: body.error_code } }] : []);
      const code = errors[0]?.extensions?.code || body?.error_code || null;
      const limited = res.status === 429 || /complexity|rate.?limit|budget/i.test(String(code || "")) || errors.some((e) => /complexity|rate limit/i.test(e.message || ""));
      if ((limited || res.status >= 500) && attempt < this.maxRetries) {
        const wait = Number(res.headers?.get?.("retry-after")) * 1000 || Number(errors[0]?.extensions?.retry_in_seconds) * 1000 || this.backoff(attempt);
        await this.sleep(Math.min(wait, 60000));
        continue;
      }
      if (res.status === 401 || res.status === 403 || /unauthori[sz]ed|USER_UNAUTHORIZED|not authenticated/i.test(String(code || "") + (errors[0]?.message || ""))) throw new MondayApiError("monday.com refused the access token. Reconnect the integration.", { status: res.status, code: "UNAUTHORIZED" });
      if (limited) throw new MondayApiError("monday.com's rate limit was reached. Try again in a minute.", { status: res.status, code: "RATE_LIMITED", retryable: true });
      if (!res.ok || errors.length || !body?.data) throw new MondayApiError(`monday.com returned an error${code ? ` (${code})` : ""}.`, { status: res.status, code: code || "MONDAY_ERROR", retryable: res.status >= 500 });
      return body.data;
    }
  }
  backoff(attempt) { return Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250); }

  async me() { return (await this.query("query { me { id name email account { id name slug } } }")).me; }

  // All workspaces this token can see (page by page).
  async workspaces() {
    const out = [];
    for (let page = 1; page < 100; page += 1) {
      const list = (await this.query("query ($page: Int!) { workspaces(limit: 100, page: $page) { id name kind } }", { page })).workspaces || [];
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  // Active boards of a workspace (or all), page by page; sub-item boards are skipped.
  async boards({ workspaceId = null } = {}) {
    const out = [];
    for (let page = 1; page < 200; page += 1) {
      const list = (await this.query(`query ($page: Int!${workspaceId ? ", $ws: [ID!]" : ""}) { boards(limit: 100, page: $page, state: active${workspaceId ? ", workspace_ids: $ws" : ""}) { id name description board_kind type workspace_id items_count } }`, { page, ...(workspaceId ? { ws: [String(workspaceId)] } : {}) })).boards || [];
      out.push(...list.filter((b) => b.type !== "sub_items_board"));
      if (list.length < 100) break;
    }
    return out;
  }

  async boardSchema(boardId) {
    const board = (await this.query("query ($ids: [ID!]) { boards(ids: $ids) { id name description workspace_id items_count columns { id title type settings_str } groups { id title } } }", { ids: [String(boardId)] })).boards?.[0];
    if (!board) throw new MondayApiError("That monday.com board doesn't exist or isn't shared with this account.", { code: "NOT_FOUND" });
    return board;
  }

  // One page of items: { items, cursor } (cursor null when there are no more).
  async itemsPage(boardId, { cursor = null, limit = 100 } = {}) {
    if (cursor) {
      const page = (await this.query(`query ($cursor: String!, $limit: Int!) { next_items_page(cursor: $cursor, limit: $limit) { cursor items { ${ITEM_FIELDS} } } }`, { cursor, limit })).next_items_page;
      return { items: page?.items || [], cursor: page?.cursor || null };
    }
    const page = (await this.query(`query ($ids: [ID!], $limit: Int!) { boards(ids: $ids) { items_page(limit: $limit) { cursor items { ${ITEM_FIELDS} } } } }`, { ids: [String(boardId)], limit })).boards?.[0]?.items_page;
    return { items: page?.items || [], cursor: page?.cursor || null };
  }

  async item(itemId) {
    return (await this.query(`query ($ids: [ID!]) { items(ids: $ids) { ${ITEM_FIELDS} board { id } } }`, { ids: [String(itemId)] })).items?.[0] || null;
  }
}

module.exports = { MondayClient, MondayApiError, API_URL };
