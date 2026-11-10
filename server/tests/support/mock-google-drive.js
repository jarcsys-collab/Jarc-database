// A mock of Google's OAuth and Drive v3 endpoints, passed in as `fetch`. Every other URL is refused and recorded, so tests can
// never reach Google. It follows the documented behaviour JARC relies on: authorization codes are single use and check PKCE,
// access tokens are required, resumable sessions report progress with 308 and Range, and a pre-generated ID used twice is a 409.
const crypto = require("crypto");

const CLIENT = Object.freeze({ id: "test-client.apps.example.invalid", secret: "test-google-client-secret" });
const ACCOUNT = "attachments@example.invalid";
const REDIRECT = "https://jarc.example.invalid/api/v1/integrations/google-drive/callback";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const ENV = Object.freeze({
  GOOGLE_DRIVE_ENABLED: "true", GOOGLE_DRIVE_CLIENT_ID: CLIENT.id, GOOGLE_DRIVE_CLIENT_SECRET: CLIENT.secret, GOOGLE_DRIVE_REDIRECT_URI: REDIRECT,
  GOOGLE_DRIVE_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"), GOOGLE_DRIVE_ACCOUNT_EMAIL: ACCOUNT, ATTACHMENTS_GDRIVE_MAX_TOTAL_MB: "100"
});

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const driveError = (status, reason) => json({ error: { code: status, message: `mock ${reason}`, errors: [{ reason }] } }, status);
const picked = (file, fields) => { const out = {}; for (const f of String(fields || "id").replace(/[()]/g, ",").split(",").filter(Boolean)) if (file[f] !== undefined) out[f] = file[f]; return out; };

function mockGoogle({ email = ACCOUNT } = {}) {
  const m = {
    files: new Map(), sessions: new Map(), codes: new Map(), accessTokens: new Set(), refreshTokens: new Set(), revoked: [], outside: [], calls: [], fail: [],
    email, permissionId: "perm-1", grant: { scope: SCOPE, refresh: true }, corruptNextUpload: false, ignoreNextId: false, interruptNextChunk: null, refreshes: 0, seq: 0,
    // What Google does when the person approves: checks the request and returns the code JARC receives.
    approve(authorizeUrl) {
      const u = new URL(authorizeUrl), code = `code-${(m.seq += 1)}`;
      m.codes.set(code, { challenge: u.searchParams.get("code_challenge"), redirect: u.searchParams.get("redirect_uri") });
      return { code, state: u.searchParams.get("state"), params: u.searchParams };
    },
    active() { return [...m.files.values()].filter((f) => !f.trashed && f.mimeType !== "application/vnd.google-apps.folder"); },
    folders() { return [...m.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.folder"); },
    add(file) { m.files.set(file.id, { createdTime: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), trashed: false, appProperties: {}, parents: [], ...file }); }
  };
  const issue = () => { const access = `access-${crypto.randomBytes(6).toString("hex")}`; m.accessTokens.add(access); return access; };
  const token = (form) => {
    if (form.get("client_id") !== CLIENT.id || form.get("client_secret") !== CLIENT.secret) return json({ error: "invalid_client" }, 401);
    if (form.get("grant_type") === "refresh_token") {
      m.refreshes += 1;
      if (!m.refreshTokens.has(form.get("refresh_token"))) return json({ error: "invalid_grant" }, 400);
      return json({ access_token: issue(), expires_in: 3599, scope: SCOPE, ...(m.rotateTo ? { refresh_token: m.refreshTokens.add(m.rotateTo) && m.rotateTo } : {}) });
    }
    const saved = m.codes.get(form.get("code"));
    m.codes.delete(form.get("code"));
    if (!saved || saved.redirect !== form.get("redirect_uri")) return json({ error: "invalid_grant" }, 400);
    if (crypto.createHash("sha256").update(form.get("code_verifier") || "").digest("base64url") !== saved.challenge) return json({ error: "invalid_grant" }, 400);
    const refresh = m.grant.refresh ? `refresh-${crypto.randomBytes(6).toString("hex")}` : null;
    if (refresh) m.refreshTokens.add(refresh);
    return json({ access_token: issue(), expires_in: 3599, scope: m.grant.scope, token_type: "Bearer", ...(refresh ? { refresh_token: refresh } : {}) });
  };
  const list = (q, url) => {
    let found = [...m.files.values()];
    if (/trashed=false/.test(q)) found = found.filter((f) => !f.trashed);
    const kind = /key='jarcKind' and value='([a-z]+)'/.exec(q)?.[1];
    if (kind) found = found.filter((f) => f.appProperties?.jarcKind === kind);
    const mime = /mimeType='([^']+)'/.exec(q)?.[1];
    if (mime) found = found.filter((f) => f.mimeType === mime);
    const before = /createdTime < '([^']+)'/.exec(q)?.[1];
    if (before) found = found.filter((f) => new Date(f.createdTime) < new Date(before));
    const size = Number(url.searchParams.get("pageSize") || 100), start = Number(url.searchParams.get("pageToken") || 0), page = found.slice(start, start + size);
    return json({ files: page.map((f) => ({ id: f.id, name: f.name })), ...(start + size < found.length ? { nextPageToken: String(start + size) } : {}) });
  };
  const putRange = async (session, init) => {
    if (init.method === "DELETE") { m.sessions.delete(session.id); return new Response(null, { status: 499 }); }
    const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(init.headers["Content-Range"] || "");
    if (!range) return driveError(400, "badContentRange");
    const progress = () => (session.finished ? json(session.finished, 200) : new Response(null, { status: 308, headers: session.bytes.length ? { Range: `bytes=0-${session.bytes.length - 1}` } : {} }));
    if (range[1] === undefined) return progress();
    if (Number(range[1]) !== session.bytes.length) return driveError(400, "wrongOffset");
    const body = Buffer.from(init.body);
    if (m.interruptNextChunk !== null) { const keep = m.interruptNextChunk; m.interruptNextChunk = null; session.bytes = Buffer.concat([session.bytes, body.subarray(0, keep)]); return driveError(503, "backendError"); }
    session.bytes = Buffer.concat([session.bytes, body]);
    if (session.bytes.length < Number(range[3])) return progress();
    const bytes = m.corruptNextUpload ? Buffer.concat([session.bytes, Buffer.from("x")]) : session.bytes;
    m.corruptNextUpload = false;
    const id = m.ignoreNextId ? `other-${(m.seq += 1)}` : session.metadata.id;
    m.ignoreNextId = false;
    m.add({ ...session.metadata, id, bytes, size: String(bytes.length), sha256Checksum: crypto.createHash("sha256").update(bytes).digest("hex"), createdTime: new Date().toISOString() });
    session.finished = { id, size: String(bytes.length), sha256Checksum: crypto.createHash("sha256").update(bytes).digest("hex") };
    return json(session.finished, 200);
  };
  const route = async (url, init) => {
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token") return token(new URLSearchParams(init.body));
    if (url.origin === "https://oauth2.googleapis.com" && url.pathname === "/revoke") { const t = new URLSearchParams(init.body).get("token"); m.revoked.push(t); m.refreshTokens.delete(t); return json({}); }
    if (url.origin !== "https://www.googleapis.com") return null;
    const upload = url.pathname === "/upload/drive/v3/files";
    if (upload && url.searchParams.get("upload_id")) { const s = m.sessions.get(url.searchParams.get("upload_id")); return s ? putRange(s, init) : driveError(404, "notFound"); }
    if (!upload && !url.pathname.startsWith("/drive/v3/")) return null;
    if (!m.accessTokens.has(String(init.headers?.Authorization || "").replace(/^Bearer /, ""))) return driveError(401, "authError");
    if (upload) {
      const metadata = JSON.parse(init.body);
      if (m.files.has(metadata.id)) return driveError(409, "fileIdInUse");
      const id = String((m.seq += 1));
      m.sessions.set(id, { id, metadata, bytes: Buffer.alloc(0), finished: null });
      return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` } });
    }
    const path = url.pathname.slice("/drive/v3".length), fields = url.searchParams.get("fields");
    if (path === "/about") return json({ user: { emailAddress: m.email, permissionId: m.permissionId } });
    if (path === "/files/generateIds") return json({ ids: [`gen-${crypto.randomBytes(8).toString("hex")}`] });
    if (path === "/files" && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (m.files.has(body.id)) return driveError(409, "fileIdInUse");
      m.add({ ...body, createdTime: new Date().toISOString() });
      return json(picked(m.files.get(body.id), fields));
    }
    if (path === "/files") return list(url.searchParams.get("q") || "", url);
    const file = m.files.get(decodeURIComponent(path.replace("/files/", "")));
    if (!file) return driveError(404, "notFound");
    if (init.method === "PATCH") { const b = JSON.parse(init.body); Object.assign(file, b, { appProperties: { ...file.appProperties, ...b.appProperties } }); return json(picked(file, fields)); }
    if (init.method === "DELETE") { m.files.delete(file.id); return new Response(null, { status: 204 }); }
    if (url.searchParams.get("alt") === "media") return new Response(file.bytes, { status: 200 });
    return json(picked({ ...file, size: file.size }, fields));
  };
  m.fetch = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || "GET";
    m.calls.push({ method, url: url.toString() });
    const rule = m.fail.findIndex((f) => (f.match ? f.match.test(`${method} ${url}`) : true));
    if (rule >= 0) {
      const [f] = m.fail.splice(rule, 1);
      if (f.network) throw new TypeError("fetch failed");
      // Some bytes get through; the connection is lost a moment later.
      if (f.truncate) return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(f.truncate)); setTimeout(() => c.error(new Error("connection lost")), 50); } }), { status: 200 });
      return f.body ? json(f.body, f.status) : driveError(f.status, f.reason || "backendError");
    }
    const res = await route(url, { ...init, method });
    if (!res) { m.outside.push(url.toString()); throw new Error(`mock Google refused ${url}`); }
    return res;
  };
  return m;
}

module.exports = { mockGoogle, ENV, ACCOUNT, REDIRECT, SCOPE, CLIENT };
