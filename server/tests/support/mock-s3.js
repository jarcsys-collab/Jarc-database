// TEST-ONLY S3-compatible server on 127.0.0.1 (path-style), enough of the S3 API for the AWS SDK's S3Client and
// lib-storage Upload: PutObject, multipart (create / upload part / complete / abort), GetObject, HeadObject,
// DeleteObject and ListObjectsV2. The bucket is PRIVATE: requests without an AWS Signature V4 Authorization header for
// the configured access key are refused (403), as a real private bucket would. Never contacts anything else.
//
//   const s3 = await startMockS3({ bucket, accessKeyId }); s3.endpoint; s3.objects (Map key → { body, contentType, meta })
//   s3.failNext({ op: "UploadPart" | "PutObject" | "GetObject" | "HeadObject" | "CompleteMultipartUpload", status, times })
//   s3.truncateNextGet()   the next GetObject sends half the body and then drops the connection
//   s3.requests            every request: { op, key, headers }
const http = require("http");
const crypto = require("crypto");

async function startMockS3({ bucket = "jarc-test-bucket", accessKeyId = "TESTKEY" } = {}) {
  const objects = new Map(), uploads = new Map(), requests = [], failures = [];
  let truncate = false;
  const xml = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/xml" }); res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`); };
  const error = (res, status, code) => xml(res, status, `<Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  const read = (req) => new Promise((resolve, reject) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject); });
  const etag = (buf) => `"${crypto.createHash("md5").update(buf).digest("hex")}"`;
  const metaOf = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith("x-amz-meta-")).map(([k, v]) => [k.slice(11), v]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const [, b, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const q = url.searchParams;
    const op = req.method === "PUT" && q.has("partNumber") ? "UploadPart" : req.method === "PUT" ? "PutObject" : req.method === "POST" && q.has("uploads") ? "CreateMultipartUpload" : req.method === "POST" && q.has("uploadId") ? "CompleteMultipartUpload" : req.method === "DELETE" && q.has("uploadId") ? "AbortMultipartUpload" : req.method === "DELETE" ? "DeleteObject" : req.method === "HEAD" ? "HeadObject" : req.method === "GET" && !key ? "ListObjectsV2" : "GetObject";
    requests.push({ op, key, headers: { ...req.headers } });
    const auth = String(req.headers.authorization || "");
    if (!auth.startsWith("AWS4-HMAC-SHA256 ") || !auth.includes(`Credential=${accessKeyId}/`)) { await read(req); return error(res, 403, "AccessDenied"); }
    if (b !== bucket) { await read(req); return error(res, 404, "NoSuchBucket"); }
    const f = failures.find((x) => x.op === op && x.times > 0);
    if (f) { f.times -= 1; await read(req); return error(res, f.status, f.status === 503 ? "SlowDown" : "InternalError"); }
    try {
      if (op === "PutObject") { const body = await read(req); objects.set(key, { body, contentType: req.headers["content-type"], meta: metaOf(req.headers), lastModified: new Date() }); res.writeHead(200, { ETag: etag(body) }); return res.end(); }
      if (op === "CreateMultipartUpload") { await read(req); const id = crypto.randomUUID(); uploads.set(id, { key, parts: new Map(), contentType: req.headers["content-type"], meta: metaOf(req.headers) }); return xml(res, 200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`); }
      if (op === "UploadPart") { const u = uploads.get(q.get("uploadId")); const body = await read(req); if (!u) return error(res, 404, "NoSuchUpload"); u.parts.set(Number(q.get("partNumber")), body); res.writeHead(200, { ETag: etag(body) }); return res.end(); }
      if (op === "CompleteMultipartUpload") { await read(req); const u = uploads.get(q.get("uploadId")); if (!u) return error(res, 404, "NoSuchUpload"); const body = Buffer.concat([...u.parts.entries()].sort((a, c) => a[0] - c[0]).map(([, p]) => p)); objects.set(u.key, { body, contentType: u.contentType, meta: u.meta, lastModified: new Date() }); uploads.delete(q.get("uploadId")); return xml(res, 200, `<CompleteMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${u.key}</Key><ETag>${etag(body)}</ETag></CompleteMultipartUploadResult>`); }
      if (op === "AbortMultipartUpload") { await read(req); uploads.delete(q.get("uploadId")); res.writeHead(204); return res.end(); }
      if (op === "DeleteObject") { await read(req); objects.delete(key); res.writeHead(204); return res.end(); }
      if (op === "HeadObject" || op === "GetObject") {
        await read(req);
        const o = objects.get(key);
        if (!o) { if (op === "HeadObject") { res.writeHead(404); return res.end(); } return error(res, 404, "NoSuchKey"); }
        const headers = { "Content-Length": String(o.body.length), "Content-Type": o.contentType || "application/octet-stream", ETag: etag(o.body), "Last-Modified": o.lastModified.toUTCString(), ...Object.fromEntries(Object.entries(o.meta).map(([k, v]) => [`x-amz-meta-${k}`, v])) };
        res.writeHead(200, headers);
        if (op === "HeadObject") return res.end();
        if (truncate) { truncate = false; res.write(o.body.subarray(0, Math.floor(o.body.length / 2))); return setTimeout(() => res.destroy(), 20); }
        return res.end(o.body);
      }
      if (op === "ListObjectsV2") {
        await read(req);
        const prefix = q.get("prefix") || "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const items = keys.map((k) => `<Contents><Key>${k}</Key><LastModified>${objects.get(k).lastModified.toISOString()}</LastModified><Size>${objects.get(k).body.length}</Size></Contents>`).join("");
        return xml(res, 200, `<ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      error(res, 400, "NotImplemented");
    } catch { error(res, 500, "InternalError"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`, bucket, accessKeyId, objects, uploads, requests,
    failNext: (rule) => failures.push({ times: 1, status: 500, ...rule }),
    truncateNextGet: () => { truncate = true; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

module.exports = { startMockS3 };
