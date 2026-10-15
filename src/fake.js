// An in-memory MDRN for tests: `@mdrnio/sdk/fake`. It serves the 19 operations of
// sdk/contracts/client.openapi.json with the real response shapes, status codes and error
// codes, behind the headers MDRN's Proxy checks (the product token, MDRN-Project,
// MDRN-Environment, Idempotency-Key on every mutation, If-Match on record updates and deletes),
// and records every request it sees. Web APIs only, so it runs wherever the SDK runs.
//
//   const fake = createFakeMdrn();
//   const mdrn = Mdrn.fromEnv(fake.env, { transfer: fake.fetch });
//
// Deterministic by design: ids derive from idempotency keys, the clock starts at 2026-01-01 and
// advances one second per request, an upload is `uploading` on its first read and an object
// `ready` (or `rejected`) on its first read after completion, so a test never waits. Three
// collection names behave specially so error paths can be reached through the SDK:
// `broken` (a 502 without an error envelope), `redirected` (a 307), `contended` (the record's
// version grows by one on every read: a writer that always gets there first) and
// `contended-once` (once per record).

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = 24 * 60 * 60 * 1000;
const LOGGED_HEADERS = ["authorization", "mdrn-project", "mdrn-environment", "idempotency-key", "if-match", "content-type", "x-mdrn-grant"];
const ATTACHMENT_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"];
const MAX_PAGE = 100;

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value, max, min = 1) => typeof value === "string" && value.length >= min && value.length <= max;

export function createFakeMdrn({
  origin = "https://app.example",
  filesOrigin = origin,
  project = "project_one",
  environment = "sandbox",
  partBytes = 16 * 1024 * 1024,
  tokens = {},
} = {}) {
  const token = { database: "database-token", storage: "storage-token", mail: "mail-token", ...tokens };
  const base = origin.replace(/\/$/, "");
  const files = filesOrigin.replace(/\/$/, "");
  const env = {
    MDRN_PROJECT_ID: project,
    MDRN_ENVIRONMENT: environment,
    MDRN_DATABASE_URL: `${base}/_mdrn/v1/database`,
    MDRN_DATABASE_TOKEN: token.database,
    MDRN_STORAGE_URL: `${base}/v1/storage`,
    MDRN_STORAGE_TOKEN: token.storage,
    MDRN_MAIL_URL: `${base}/v1/mail`,
    MDRN_MAIL_TOKEN: token.mail,
    MDRN_PRODUCTS: { fetch: (input, init) => fetch(input, init) },
  };

  const collections = new Map();
  const uploads = new Map();
  const objects = new Map();
  const grants = new Map();
  const operations = new Map();
  const templates = new Map([["welcome", { subject: "Welcome", text: "Welcome aboard.", html: null }]]);
  const users = new Map();
  const sent = [];
  const log = [];
  let replays = new Map();
  let bumped = new Set();
  let clock = Date.UTC(2026, 0, 1);
  let requests = 0;

  const now = () => new Date(clock).toISOString();
  const at = (ms) => new Date(clock + ms).toISOString();
  const id = async (prefix, key) => `${prefix}_${(await sha256(new TextEncoder().encode(`${project}:${environment}:${prefix}:${key}`))).slice(0, 32)}`;
  const json = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const fail = (status, code, message) => json(status, { error: { code, message, retryable: status === 503, requestId: `req_${requests}` } });

  function collection(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }

  // A page of `items` for the limit and cursor of `query`: cursors are `cursor-<offset>`.
  function page(items, query, invalid) {
    const extra = [...query.keys()].filter((k) => !["limit", "cursor"].includes(k));
    if (extra.length) return fail(400, invalid, `Unsupported list parameter: ${extra[0]}`);
    let limit = 50;
    if (query.has("limit")) {
      limit = Number(query.get("limit"));
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return fail(400, invalid, "List limit exceeds configured page maximum");
    }
    let offset = 0;
    if (query.has("cursor")) {
      const match = /^cursor-(\d+)$/.exec(query.get("cursor"));
      if (!match) return fail(400, invalid, "Invalid cursor");
      offset = Number(match[1]);
    }
    const slice = items.slice(offset, offset + limit);
    return json(200, { items: slice, nextCursor: offset + limit < items.length ? `cursor-${offset + limit}` : null });
  }

  const uploadView = (u) => ({ id: u.id, objectId: u.objectId, state: u.state, expiresAt: u.expiresAt, operationId: u.operationId, partBytes });
  const objectView = (o) => ({ id: o.id, filename: o.filename, contentType: o.contentType, bytes: o.bytes, sha256: o.sha256, state: o.state, createdAt: o.createdAt, deletedAt: o.deletedAt, purgeAt: o.purgeAt });
  const partView = (p) => ({ partNumber: p.partNumber, bytes: p.bytes, etag: p.etag, state: p.state });

  async function database(method, path, query, body, key, ifMatch) {
    const match = /^\/collections\/([^/]+)\/records(?:\/([^/]+))?$/.exec(path);
    if (!match) return fail(404, "NOT_FOUND", "Unknown record route");
    const name = decodeURIComponent(match[1]);
    const recordId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (name === "broken") return new Response("Bad gateway", { status: 502, headers: { "content-type": "text/plain" } });
    if (name === "redirected") return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } });
    const records = collection(name);
    if (recordId === undefined) {
      if (method === "GET") return page([...records.values()], query, "INVALID_REQUEST");
      if (method !== "POST") return fail(405, "INVALID_REQUEST", "Unsupported record operation");
      if (!isObject(body) || !isObject(body.data)) return fail(400, "INVALID_REQUEST", "Expected a data object");
      const record = { id: await id("rec", key), collection: name, version: 1, data: structuredClone(body.data), createdAt: now(), updatedAt: now() };
      records.set(record.id, record);
      return json(201, record);
    }
    const record = records.get(recordId);
    if (!record) return fail(404, "NOT_FOUND", "Record not found");
    if (method === "GET") {
      const view = structuredClone(record);
      // A concurrent writer, simulated: the version read is stale by the time it is used.
      if (name === "contended" || (name === "contended-once" && !bumped.has(record.id))) {
        bumped.add(record.id);
        record.version += 1;
        record.updatedAt = now();
      }
      return json(200, view);
    }
    if (method !== "PATCH" && method !== "DELETE") return fail(405, "INVALID_REQUEST", "Unsupported record operation");
    if (ifMatch === undefined) return fail(400, "INVALID_REQUEST", "If-Match is required");
    if (ifMatch !== record.version) return fail(409, "CONFLICT", "If-Match must equal the current record version");
    if (method === "DELETE") {
      records.delete(recordId);
      return json(200, { deleted: true });
    }
    if (!isObject(body) || !isObject(body.data)) return fail(400, "INVALID_REQUEST", "Expected a data object");
    // A shallow merge: the fields given replace or join the record's; the others stay.
    record.data = { ...record.data, ...structuredClone(body.data) };
    record.version += 1;
    record.updatedAt = now();
    return json(200, structuredClone(record));
  }

  async function storage(method, path, query, body, key) {
    const route = `${method} ${path.replace(/^\/(uploads|objects|operations)\/[^/]+/, "/$1/{id}")}`;
    const target = /^\/(?:uploads|objects|operations)\/([^/]+)/.exec(path)?.[1];
    switch (route) {
      case "POST /uploads": {
        const keys = isObject(body) ? Object.keys(body) : [];
        if (!isObject(body) || keys.some((k) => !["filename", "contentType", "bytes", "sha256"].includes(k))
          || !isText(body.filename, 255) || !isText(body.contentType, 128)
          || !Number.isInteger(body.bytes) || body.bytes < 0 || body.bytes > 10 * 1024 * 1024 * 1024
          || !/^[a-fA-F0-9]{64}$/.test(body.sha256 ?? "")) return fail(400, "INVALID_INPUT", "Invalid upload request");
        const upload = {
          id: await id("upl", key), objectId: await id("obj", key), state: "pending", next: "uploading", expiresAt: at(DAY), operationId: null,
          filename: body.filename, contentType: body.contentType, bytes: body.bytes, sha256: body.sha256.toLowerCase(), parts: new Map(),
        };
        uploads.set(upload.id, upload);
        return json(202, uploadView(upload));
      }
      case "GET /uploads": return page([...uploads.values()].map(uploadView), query, "INVALID_INPUT");
      case "GET /uploads/{id}": {
        const upload = uploads.get(target);
        if (!upload) return fail(404, "NOT_FOUND", "Upload not found");
        if (upload.next) { upload.state = upload.next; upload.next = null; }
        return json(200, uploadView(upload));
      }
      case "DELETE /uploads/{id}": {
        const upload = uploads.get(target);
        if (!upload) return fail(404, "NOT_FOUND", "Upload not found");
        if (!["pending", "uploading"].includes(upload.next ?? upload.state)) return fail(409, "CONFLICT", `Upload is ${upload.state}`);
        upload.state = "aborted"; upload.next = null;
        return json(204);
      }
      case "GET /uploads/{id}/parts": {
        const upload = uploads.get(target);
        if (!upload) return fail(404, "NOT_FOUND", "Upload not found");
        return page([...upload.parts.values()].sort((a, b) => a.partNumber - b.partNumber).map(partView), query, "INVALID_INPUT");
      }
      case "POST /uploads/{id}/parts": {
        const upload = uploads.get(target);
        if (!upload) return fail(404, "NOT_FOUND", "Upload not found");
        if (upload.state !== "uploading") return fail(409, "CONFLICT", `Upload is ${upload.state}, not uploading`);
        if (!isObject(body) || Object.keys(body).some((k) => !["partNumber", "bytes"].includes(k))
          || !Number.isInteger(body.partNumber) || body.partNumber < 1 || body.partNumber > 640
          || !Number.isInteger(body.bytes) || body.bytes < 1 || body.bytes > partBytes) return fail(400, "INVALID_INPUT", "Invalid part request");
        const grant = { id: await id("grant", key), method: "PUT", uploadId: upload.id, partNumber: body.partNumber, maxBytes: body.bytes, expiresAt: at(15 * 60 * 1000) };
        grants.set(grant.id, grant);
        return json(202, { id: grant.id, url: `${files}/transfer/${grant.id}`, method: "PUT", headers: { "x-mdrn-grant": grant.id }, expiresAt: grant.expiresAt, maxBytes: grant.maxBytes });
      }
      case "POST /uploads/{id}/complete": {
        const upload = uploads.get(target);
        if (!upload) return fail(404, "NOT_FOUND", "Upload not found");
        if (upload.state !== "uploading") return fail(409, "CONFLICT", `Upload is ${upload.state}, not uploading`);
        if (!isObject(body) || !Array.isArray(body.parts) || body.parts.length > 640
          || body.parts.some((p) => !isObject(p) || !Number.isInteger(p.partNumber) || typeof p.etag !== "string")) return fail(400, "INVALID_INPUT", "Invalid completion request");
        const ready = [...upload.parts.values()].filter((p) => p.state === "ready");
        const given = new Map(body.parts.map((p) => [p.partNumber, p.etag]));
        if (given.size !== body.parts.length || given.size !== ready.length || ready.some((p) => given.get(p.partNumber) !== p.etag)) {
          return fail(400, "INVALID_INPUT", "Parts do not match the upload's ready parts");
        }
        const data = new Uint8Array(ready.reduce((n, p) => n + p.bytes, 0));
        let offset = 0;
        for (const part of ready.sort((a, b) => a.partNumber - b.partNumber)) { data.set(part.data, offset); offset += part.bytes; }
        const verified = data.byteLength === upload.bytes && (await sha256(data)) === upload.sha256;
        const operation = { id: await id("op", key), kind: "verify", state: verified ? "succeeded" : "failed", processedBytes: data.byteLength, processedItems: ready.length, attempts: 1, retryAt: null, error: verified ? null : "SHA256_MISMATCH" };
        operations.set(operation.id, operation);
        objects.set(upload.objectId, { id: upload.objectId, filename: upload.filename, contentType: upload.contentType, bytes: upload.bytes, sha256: upload.sha256, state: "verifying", next: verified ? "ready" : "rejected", createdAt: now(), deletedAt: null, purgeAt: null, data });
        upload.state = "verifying"; upload.next = verified ? "complete" : "rejected"; upload.operationId = operation.id;
        return json(202, { id: upload.objectId, filename: upload.filename, contentType: upload.contentType, bytes: upload.bytes, state: "verifying", operationId: operation.id });
      }
      case "GET /objects": {
        if (query.has("state") && query.get("state") !== "ready") return fail(403, "FORBIDDEN", "Listing deleted or lost objects requires management authority");
        query.delete("state");
        return page([...objects.values()].filter((o) => (o.next ?? o.state) === "ready").map((o) => objectView(o.next ? { ...o, state: o.next } : o)), query, "INVALID_INPUT");
      }
      case "GET /objects/{id}": {
        const object = objects.get(target);
        if (!object || object.state === "deleted") return fail(404, "NOT_FOUND", "Object not found");
        if (object.next) { object.state = object.next; object.next = null; }
        return json(200, objectView(object));
      }
      case "DELETE /objects/{id}": {
        const object = objects.get(target);
        if (!object || object.state === "deleted") return fail(404, "NOT_FOUND", "Object not found");
        object.state = "deleted"; object.next = null; object.deletedAt = now(); object.purgeAt = at(30 * DAY);
        return json(204);
      }
      case "POST /objects/{id}/download-grants": {
        const object = objects.get(target);
        if (!object || object.state === "deleted") return fail(404, "NOT_FOUND", "Object not found");
        if ((object.next ?? object.state) !== "ready") return fail(409, "CONFLICT", `Object is ${object.next ?? object.state}, not ready`);
        const grant = { id: await id("grant", key), method: "GET", objectId: object.id, maxBytes: object.bytes, expiresAt: at(15 * 60 * 1000) };
        grants.set(grant.id, grant);
        return json(200, { id: grant.id, url: `${files}/transfer/${grant.id}`, method: "GET", headers: {}, expiresAt: grant.expiresAt, maxBytes: grant.maxBytes });
      }
      case "GET /operations/{id}": {
        const operation = operations.get(target);
        return operation ? json(200, operation) : fail(404, "NOT_FOUND", "Operation not found");
      }
      default: return fail(404, "NOT_FOUND", "Unknown Storage route");
    }
  }

  // The Files gateway: a grant URL is the whole credential, so a product token or the MDRN
  // headers on such a request are a leak, and the fake refuses them to make that visible.
  async function transfer(request, grantId) {
    if (request.headers.has("authorization") || request.headers.has("mdrn-project") || request.headers.has("idempotency-key")) {
      return fail(403, "GRANT_REJECTED", "A grant URL takes no credentials: send only the grant's own headers");
    }
    const grant = grants.get(grantId);
    if (!grant || grant.method !== request.method) return fail(403, "GRANT_REJECTED", "Invalid, expired or revoked grant");
    if (grant.method === "GET") {
      const object = objects.get(grant.objectId);
      if (!object || (object.next ?? object.state) !== "ready") return fail(404, "NOT_FOUND", "Object is not ready or no longer available");
      return new Response(object.data, { status: 200, headers: { "content-type": object.contentType, "content-length": String(object.bytes), etag: `"${object.sha256.slice(0, 16)}"` } });
    }
    if (request.headers.get("x-mdrn-grant") !== grant.id) return fail(403, "GRANT_REJECTED", "The grant's headers are missing");
    const upload = uploads.get(grant.uploadId);
    if (!upload || upload.state !== "uploading") return fail(409, "CONFLICT", "The upload is not accepting parts");
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.byteLength !== grant.maxBytes) return fail(400, "PART_SIZE_MISMATCH", "Part bytes do not match the grant");
    const part = { partNumber: grant.partNumber, bytes: data.byteLength, etag: `"${(await sha256(data)).slice(0, 16)}"`, state: "ready", data };
    upload.parts.set(part.partNumber, part);
    return json(200, { partNumber: part.partNumber, bytes: part.bytes, etag: part.etag });
  }

  async function mail(method, path, query, body, key) {
    if (query.size) return fail(400, "INVALID_REQUEST", "Mail takes no query parameters");
    if (method !== "POST" || path !== "/messages") return fail(404, "NOT_FOUND", "Unknown Mail route");
    const fields = ["recipient", "subject", "text", "html", "templateId", "attachments", "senderId"];
    if (!isObject(body) || Object.keys(body).some((k) => !fields.includes(k))) return fail(400, "INVALID_MESSAGE", "Invalid message");
    if (!isText(body.recipient, 254) || !body.recipient.includes("@")) return fail(400, "INVALID_MESSAGE", "Invalid recipient");
    const attachments = body.attachments ?? [];
    if (!Array.isArray(attachments) || attachments.length > 4 || attachments.some((a) => !isObject(a) || !isText(a.filename, 128) || !ATTACHMENT_TYPES.includes(a.type) || typeof a.content !== "string")) {
      return fail(400, "INVALID_MESSAGE", "Invalid attachments");
    }
    if (body.senderId !== undefined && !IDENTIFIER.test(body.senderId)) return fail(400, "INVALID_MESSAGE", "Invalid senderId");
    let content;
    if (body.templateId !== undefined) {
      if (!IDENTIFIER.test(body.templateId) || Object.keys(body).some((k) => !["templateId", "recipient", "attachments", "senderId"].includes(k))) {
        return fail(400, "INVALID_MESSAGE", "A template send takes only recipient, attachments and senderId");
      }
      const template = templates.get(body.templateId);
      if (!template) return fail(422, "TEMPLATE_NOT_FOUND", "No such template");
      content = { ...template };
    } else {
      if (!isText(body.subject, 256) || !isText(body.text, 32768) || (body.html !== undefined && body.html !== null && !isText(body.html, 32768, 0))) {
        return fail(400, "INVALID_MESSAGE", "subject and text are required without a template");
      }
      content = { subject: body.subject, text: body.text, html: body.html ?? null };
    }
    const message = { id: await id("msg", key), recipient: body.recipient, ...content, attachments: structuredClone(attachments), senderId: body.senderId ?? null, templateId: body.templateId ?? null };
    sent.push(message);
    return json(202, { id: message.id, state: "queued", requestId: `req_${requests}` });
  }

  function me(request) {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const user = bearer === undefined ? undefined : users.get(bearer);
    if (!user) return fail(401, "UNAUTHENTICATED", "Sign in again");
    const profile = { id: user.id, metadataState: "not_configured" };
    if (user.email) profile.email = user.email;
    if (user.name) profile.name = user.name;
    return json(200, profile);
  }

  async function serve(request) {
    requests += 1;
    clock += 1000;
    const url = new URL(request.url);
    const method = request.method;
    const entry = { method, path: url.pathname + url.search, headers: {}, body: null };
    for (const name of LOGGED_HEADERS) if (request.headers.has(name)) entry.headers[name] = request.headers.get(name);
    log.push(entry);
    const response = await route(request, url, method, entry);
    entry.status = response.status;
    return response;
  }

  async function route(request, url, method, entry) {
    const grantId = /^\/transfer\/([^/]+)$/.exec(url.pathname)?.[1];
    if (grantId) {
      if (method === "PUT") entry.body = { bytes: Number(request.headers.get("content-length") ?? 0) || undefined };
      const response = await transfer(request, grantId);
      if (method === "PUT" && entry.body.bytes === undefined) entry.body = { bytes: (await response.clone().json().catch(() => ({}))).bytes ?? null };
      return response;
    }
    if (url.pathname === "/v1/auth/me") return method === "GET" ? me(request) : fail(405, "INVALID_REQUEST", "Unsupported method");
    const product = url.pathname.startsWith("/_mdrn/v1/database/") ? "database" : url.pathname.startsWith("/v1/storage/") ? "storage" : url.pathname.startsWith("/v1/mail/") ? "mail" : null;
    if (!product) return fail(404, "NOT_FOUND", "Not an MDRN product route");
    const path = url.pathname.slice(product === "database" ? "/_mdrn/v1/database".length : product === "storage" ? "/v1/storage".length : "/v1/mail".length);
    if (request.headers.get("authorization") !== `Bearer ${token[product]}`) return fail(401, "PRODUCT_ACCESS_DENIED", "Product access is unavailable for this request.");
    if (request.headers.get("mdrn-project") !== project || request.headers.get("mdrn-environment") !== environment) return fail(403, "PRODUCT_ACCESS_DENIED", "Product access is unavailable for this request.");
    const key = request.headers.get("idempotency-key") ?? undefined;
    if (method !== "GET" && !IDENTIFIER.test(key ?? "")) return fail(400, "INVALID_REQUEST", "Idempotency-Key is required on every mutation");
    let ifMatch;
    if (request.headers.has("if-match")) {
      ifMatch = Number(request.headers.get("if-match"));
      if (!/^[1-9]\d*$/.test(request.headers.get("if-match"))) return fail(400, "INVALID_REQUEST", "If-Match must be a positive record version");
    }
    let body;
    if (method !== "GET") {
      const text = await request.text();
      if (text) {
        try { body = JSON.parse(text); } catch { return fail(400, "INVALID_REQUEST", "The body is not JSON"); }
      }
      entry.body = body ?? null;
    }
    // Idempotency: the same key sends back the first answer; with another request it is a conflict.
    const replayKey = `${product} ${method} ${path} ${key}`;
    const fingerprint = JSON.stringify([body ?? null, ifMatch ?? null]);
    const replay = method === "GET" ? undefined : replays.get(replayKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) return fail(409, "CONFLICT", "Idempotency key reused with another request");
      return json(replay.status, replay.body);
    }
    const response = product === "database" ? await database(method, path, url.searchParams, body, key, ifMatch)
      : product === "storage" ? await storage(method, path, url.searchParams, body, key)
        : await mail(method, path, url.searchParams, body, key);
    if (method !== "GET" && response.ok) replays.set(replayKey, { fingerprint, status: response.status, body: response.status === 204 ? undefined : await response.clone().json() });
    return response;
  }

  // As a service binding's fetch, a global fetch or a Miniflare handler: a Request (of any
  // realm's Request class) is served as it is; anything else becomes one. Miniflare calls a
  // function binding as (request, miniflare), so only a plain object counts as a RequestInit.
  function fetch(input, init) {
    const isRequest = input !== null && typeof input === "object" && typeof input.url === "string" && typeof input.headers?.get === "function";
    const isInit = init !== null && typeof init === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(init));
    return serve(isRequest && !isInit ? input : new Request(input, init));
  }

  return {
    env,
    fetch,
    collections,
    uploads,
    objects,
    operations,
    templates,
    sent,
    log,
    /** Makes `id` a signed-in user and gives the two headers MDRN's Proxy adds to their
     * requests, to put on a Request handed to auth.user or auth.me. */
    signIn(id, email, token = `identity-token-${id}`) {
      users.set(token, { id, email });
      return { "x-mdrn-user-id": id, "x-mdrn-identity-token": token };
    },
    /** Sends bytes to a part grant's URL as a browser or the SDK would, and gives the gateway's
     * answer ({partNumber, bytes, etag}). */
    async putBytes(grantUrl, bytes) {
      const grantId = /\/transfer\/([^/]+)$/.exec(new URL(grantUrl).pathname)?.[1];
      const response = await serve(new Request(grantUrl, { method: "PUT", headers: { "x-mdrn-grant": grantId ?? "" }, body: bytes }));
      const payload = await response.json();
      if (!response.ok) throw new Error(`${payload.error.code}: ${payload.error.message}`);
      return payload;
    },
    /** Fetches a download grant's URL and gives the bytes. */
    async getBytes(grantUrl) {
      const response = await serve(new Request(grantUrl));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    /** Forgets every record, upload, object, message, replay and log entry; templates and
     * signed-in users stay. */
    reset() {
      collections.clear(); uploads.clear(); objects.clear(); grants.clear(); operations.clear();
      sent.length = 0; log.length = 0; replays = new Map(); bumped = new Set();
      clock = Date.UTC(2026, 0, 1); requests = 0;
    },
  };
}
