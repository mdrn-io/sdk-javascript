// The client against the fake MDRN of src/fake.js: what it sends, what it answers and how it
// fails. The conformance runner (test/conformance.js) covers the shared transcript; these are
// the JavaScript-specific details and the fake's own rules.
import test from "node:test";
import assert from "node:assert/strict";
import { Mdrn, MdrnError, scheduledRun } from "../src/index.js";
import { createFakeMdrn } from "../src/fake.js";

const bytes = (text) => new TextEncoder().encode(text);
const client = (options = {}) => {
  const fake = createFakeMdrn({ partBytes: 8, ...options });
  return { fake, mdrn: Mdrn.fromEnv(fake.env, { transfer: fake.fetch }) };
};
const rejects = (promise, status, code) => assert.rejects(promise, (error) => error instanceof MdrnError && error.status === status && error.code === code);

test("fromEnv takes the release's variables, sends through MDRN_PRODUCTS and lists the products it has", async () => {
  const { fake, mdrn } = client();
  assert.deepEqual(mdrn.enabled, ["db", "files", "mail"]);
  const record = await mdrn.db.create("tasks", { done: false });
  assert.equal(record.version, 1);
  assert.equal(record.collection, "tasks");
  const [seen] = fake.log;
  assert.equal(seen.method, "POST");
  assert.equal(seen.path, "/_mdrn/v1/database/collections/tasks/records");
  assert.equal(seen.headers.authorization, "Bearer database-token");
  assert.equal(seen.headers["mdrn-project"], "project_one");
  assert.equal(seen.headers["mdrn-environment"], "sandbox");
  assert.match(seen.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(seen.headers["content-type"], "application/json");
  assert.deepEqual(seen.body, { data: { done: false } });
});

test("a product the release does not have is PRODUCT_NOT_ENABLED, naming the variable", async () => {
  const fake = createFakeMdrn();
  const { MDRN_STORAGE_URL, MDRN_MAIL_TOKEN, ...env } = fake.env;
  const mdrn = Mdrn.fromEnv(env);
  assert.deepEqual(mdrn.enabled, ["db"]);
  await assert.rejects(() => mdrn.files.get("obj_1"), (error) => error instanceof MdrnError && error.status === 0 && error.code === "PRODUCT_NOT_ENABLED"
    && error.message === "Files is not enabled for this environment (MDRN_STORAGE_URL is missing)");
  await assert.rejects(() => mdrn.mail.send({ to: "a@b.example", subject: "s", text: "t" }), /Mail is not enabled for this environment \(MDRN_MAIL_TOKEN is missing\)/);
  assert.equal(fake.log.length, 0);
  const direct = new Mdrn({ origin: "https://app.example", project: "p", environment: "production", tokens: { mail: "m" } });
  assert.deepEqual(direct.enabled, ["mail"]);
  await assert.rejects(() => direct.db.get("tasks", "x"), /Database is not enabled for this environment \(MDRN_DATABASE_TOKEN is missing\)/);
});

test("records: get is null when missing, update merges shallowly, delete needs no version", async () => {
  const { fake, mdrn } = client();
  assert.equal(await mdrn.db.get("tasks", "rec_none"), null);
  const created = await mdrn.db.create("tasks", { title: "a", tags: ["x"] });
  const updated = await mdrn.db.update("tasks", created.id, { done: true });
  assert.deepEqual(updated.data, { title: "a", tags: ["x"], done: true });
  assert.equal(updated.version, 2);
  const page = await mdrn.db.list("tasks", { limit: 10 });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  await mdrn.db.delete("tasks", created.id);
  assert.equal(await mdrn.db.get("tasks", created.id), null);
  assert.deepEqual(fake.log.map((e) => `${e.method} ${e.status} ${e.headers["if-match"] ?? "-"}`), ["GET 404", "POST 201", "GET 200", "PATCH 200 1", "GET 200", "GET 200", "DELETE 200 2", "GET 404"].map((s) => (s.split(" ").length === 2 ? `${s} -` : s)));
});

test("an explicit version is sent as If-Match once and a conflict is the caller's; an implicit one is retried three times", async () => {
  const { fake, mdrn } = client();
  const created = await mdrn.db.create("tasks", { n: 1 });
  await mdrn.db.update("tasks", created.id, { n: 2 }, { version: 1, idempotencyKey: "update-1" });
  await rejects(mdrn.db.update("tasks", created.id, { n: 3 }, { version: 1 }), 409, "CONFLICT");
  assert.equal(fake.log.filter((e) => e.method === "PATCH").length, 2);
  assert.throws(() => mdrn.db.update("tasks", created.id, { n: 3 }, { version: 0 }), TypeError);
  fake.log.length = 0;
  const contended = await mdrn.db.create("contended", { n: 1 });
  await rejects(mdrn.db.update("contended", contended.id, { n: 2 }, { idempotencyKey: "first" }), 409, "CONFLICT");
  const patches = fake.log.filter((e) => e.method === "PATCH");
  assert.equal(patches.length, 4);
  assert.deepEqual(patches.map((e) => e.headers["if-match"]), ["1", "2", "3", "4"]);
  // The caller's key is used once; every retry is its own change with a fresh key.
  assert.equal(patches[0].headers["idempotency-key"], "first");
  assert.equal(new Set(patches.map((e) => e.headers["idempotency-key"])).size, 4);
});

test("errors: the envelope's code, HTTP_ERROR without one, UNEXPECTED_REDIRECT for a 3xx that is never followed", async () => {
  const { fake, mdrn } = client();
  await rejects(mdrn.db.list("tasks", { limit: 0 }), 400, "INVALID_REQUEST");
  await assert.rejects(() => mdrn.db.list("broken"), (error) => error.status === 502 && error.code === "HTTP_ERROR" && error.message === "MDRN request failed with HTTP 502");
  await assert.rejects(() => mdrn.db.list("redirected"), (error) => error.status === 307 && error.code === "UNEXPECTED_REDIRECT" && error.details.location === "https://elsewhere.example/");
  assert.equal(fake.log.length, 3);
  // A bare {code, message} body is read too.
  const bare = new Mdrn({ origin: "https://app.example", project: "p", environment: "sandbox", tokens: { database: "t" }, fetcher: async () => Response.json({ code: "TEAPOT", message: "short and stout" }, { status: 418 }) });
  await rejects(bare.db.get("tasks", "x"), 418, "TEAPOT");
});

test("transport: a deadline is TIMEOUT, a failed connection NETWORK_ERROR, the caller's abort is theirs", async () => {
  // A fetch that never answers and only ends when its request's signal aborts.
  const never = (request) => new Promise((_, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener("abort", () => reject(request.signal.reason));
  });
  const slow = new Mdrn({ origin: "https://app.example", project: "p", environment: "sandbox", tokens: { database: "t" }, timeoutMs: 20, fetcher: never });
  await rejects(slow.db.get("tasks", "x"), 0, "TIMEOUT");
  const down = new Mdrn({ origin: "https://app.example", project: "p", environment: "sandbox", tokens: { database: "t" }, fetcher: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(() => down.db.get("tasks", "x"), (error) => error.code === "NETWORK_ERROR" && error.details instanceof TypeError);
  const controller = new AbortController();
  controller.abort(new Error("mine"));
  await assert.rejects(() => slow.db.list("tasks", { signal: controller.signal }), /mine/);
});

test("the token goes only over https, or plain http to this machine; the environment is sandbox or production", () => {
  const make = (origin) => new Mdrn({ origin, project: "p", environment: "sandbox", tokens: { database: "t" } });
  for (const origin of ["http://app.example", "ftp://app.example", "not a url", "http://127.0.0.2"]) assert.throws(() => make(origin), /https/);
  for (const origin of ["https://app.example", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"]) make(origin);
  assert.throws(() => new Mdrn({ origin: "https://app.example", project: "p", environment: "development", tokens: {} }), /sandbox or production/);
  assert.throws(() => Mdrn.fromEnv({ ...createFakeMdrn().env, MDRN_MAIL_URL: "http://mail.example" }), /MDRN_MAIL_URL/);
  // No token at all is a client that can only read who is calling.
  assert.deepEqual(new Mdrn({ project: "p", environment: "sandbox" }).enabled, []);
});

test("files.upload: SHA-256 up front, parts of the session's size to the grant URLs without the token, then the verified file", async () => {
  const { fake, mdrn } = client();
  const file = await mdrn.files.upload({ name: "hello.bin", bytes: bytes("hello, world") }, { idempotencyKey: "up" });
  assert.equal(file.state, "ready");
  assert.equal(file.bytes, 12);
  assert.equal(file.contentType, "application/octet-stream");
  assert.equal(file.sha256, "09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b");
  const steps = fake.log.map((e) => `${e.method} ${e.path.replace(/[a-z]+_[0-9a-f]{32}/g, "ID")}`);
  assert.deepEqual(steps, ["POST /v1/storage/uploads", "GET /v1/storage/uploads/ID", "POST /v1/storage/uploads/ID/parts", "PUT /transfer/ID", "POST /v1/storage/uploads/ID/parts", "PUT /transfer/ID", "POST /v1/storage/uploads/ID/complete", "GET /v1/storage/objects/ID"]);
  assert.deepEqual(fake.log.filter((e) => e.method === "POST").map((e) => e.headers["idempotency-key"]), ["up", "up-part-1", "up-part-2", "up-complete"]);
  for (const put of fake.log.filter((e) => e.method === "PUT")) {
    assert.equal(put.headers.authorization, undefined);
    assert.match(put.headers["x-mdrn-grant"], /^grant_/);
  }
  assert.deepEqual(fake.log.filter((e) => e.method === "PUT").map((e) => e.body.bytes), [8, 4]);
  const { url } = await mdrn.files.downloadUrl(file.id);
  assert.equal(new TextDecoder().decode(await fake.getBytes(url)), "hello, world");
  // wait: false reads the object once after completion and never polls; the fake verifies an
  // object on its first read, so it is already ready here (on MDRN it is usually verifying).
  fake.log.length = 0;
  const empty = await mdrn.files.upload({ name: "empty", bytes: new Uint8Array(0), type: "text/plain" }, { wait: false });
  assert.equal(empty.state, "ready");
  assert.equal(empty.bytes, 0);
  assert.deepEqual(fake.log.map((e) => `${e.method} ${e.path.replace(/[a-z]+_[0-9a-f]{32}/g, "ID")}`), ["POST /v1/storage/uploads", "GET /v1/storage/uploads/ID", "POST /v1/storage/uploads/ID/complete", "GET /v1/storage/objects/ID"]);
  assert.throws(() => mdrn.files.upload({ name: "x", bytes: "text" }), TypeError);
});

test("files.uploads: the session as the wire has it, including a rejected upload and its operation", async () => {
  const { fake, mdrn } = client();
  const data = bytes("abc");
  const wrong = "0000000000000000000000000000000000000000000000000000000000000000";
  const upload = await mdrn.files.uploads.create({ filename: "a.txt", contentType: "text/plain", bytes: 3, sha256: wrong });
  assert.equal(upload.state, "pending");
  assert.equal(upload.partBytes, 8);
  assert.equal((await mdrn.files.uploads.get(upload.id)).state, "uploading");
  const grant = await mdrn.files.uploads.part(upload.id, { partNumber: 1, size: 3 });
  const { etag } = await fake.putBytes(grant.url, data);
  assert.deepEqual((await mdrn.files.uploads.parts(upload.id)).items.map((p) => [p.partNumber, p.bytes, p.state]), [[1, 3, "ready"]]);
  const completion = await mdrn.files.uploads.complete(upload.id, [{ partNumber: 1, etag }]);
  assert.equal(completion.state, "verifying");
  assert.equal((await mdrn.files.get(completion.id)).state, "rejected");
  assert.equal((await mdrn.files.operation(completion.operationId)).state, "failed");
  assert.equal((await mdrn.files.uploads.get(upload.id)).state, "rejected");
  await rejects(mdrn.files.downloadUrl(completion.id), 409, "CONFLICT");
  assert.equal(await mdrn.files.uploads.get("upl_none"), null);
  const other = await mdrn.files.uploads.create({ filename: "b.txt", contentType: "text/plain", bytes: 1, sha256: wrong });
  await mdrn.files.uploads.abort(other.id);
  assert.equal((await mdrn.files.uploads.get(other.id)).state, "aborted");
  assert.equal((await mdrn.files.uploads.list()).items.length, 2);
  await rejects(mdrn.files.operation("op_none"), 404, "NOT_FOUND");
});

test("mail.send: to becomes recipient, template becomes templateId, and the template rule holds before any request", async () => {
  const { fake, mdrn } = client();
  const queued = await mdrn.mail.send({ to: "a@b.example", subject: "Hi", text: "Hello", html: "<p>Hello</p>" }, { idempotencyKey: "m1" });
  assert.equal(queued.state, "queued");
  assert.deepEqual(fake.log[0].body, { recipient: "a@b.example", subject: "Hi", text: "Hello", html: "<p>Hello</p>" });
  await mdrn.mail.send({ to: "a@b.example", template: "welcome", attachments: [{ filename: "a.txt", type: "text/plain", content: "aGk=" }] });
  assert.deepEqual(fake.log[1].body, { recipient: "a@b.example", templateId: "welcome", attachments: [{ filename: "a.txt", type: "text/plain", content: "aGk=" }] });
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[1].subject, "Welcome");
  assert.equal(fake.sent[1].templateId, "welcome");
  assert.throws(() => mdrn.mail.send({ to: "a@b.example", template: "welcome", text: "no" }), TypeError);
  assert.throws(() => mdrn.mail.send({ to: "a@b.example", recipient: "a@b.example", subject: "s", text: "t" }), /Unknown mail field: recipient/);
  assert.throws(() => mdrn.mail.send({ subject: "s", text: "t" }), /to is required/);
  assert.equal(fake.log.length, 2);
  await rejects(mdrn.mail.send({ to: "a@b.example", template: "nope" }), 422, "TEMPLATE_NOT_FOUND");
  await rejects(mdrn.mail.send({ to: "a@b.example", subject: "s" }), 400, "INVALID_MESSAGE");
});

test("auth: the visitor from the headers only MDRN can set, and their profile from /v1/auth/me through the binding", async () => {
  const { fake, mdrn } = client();
  const headers = fake.signIn("user_1", "user@example.com");
  const request = new Request("https://app.example/account", { headers });
  assert.deepEqual(mdrn.auth.user(request), { id: "user_1", token: "identity-token-user_1" });
  assert.equal(mdrn.auth.user(new Request("https://app.example/")), null);
  assert.equal(mdrn.auth.user(new Request("https://app.example/", { headers: { "x-mdrn-user-id": "bad id", "x-mdrn-identity-token": "t" } })), null);
  assert.equal(mdrn.auth.user(new Request("https://app.example/", { headers: { "x-mdrn-user-id": "user_1" } })), null);
  assert.deepEqual(await mdrn.auth.me(request), { id: "user_1", email: "user@example.com", metadataState: "not_configured" });
  assert.equal(fake.log[0].path, "/v1/auth/me");
  assert.equal(fake.log[0].headers.authorization, "Bearer identity-token-user_1");
  assert.equal(await mdrn.auth.me(new Request("https://app.example/")), null);
  assert.equal(await mdrn.auth.me(new Request("https://app.example/", { headers: { ...headers, "x-mdrn-identity-token": "expired" } })), null);
  assert.equal(fake.log.length, 2);
});

test("recognises a schedule run by the headers only MDRN can send", () => {
  assert.equal(scheduledRun(new Request("https://app.example/tasks/sync", { method: "POST" })), null);
  const run = scheduledRun(new Request("https://app.example/tasks/sync", { method: "POST", headers: { "x-mdrn-schedule": "sync", "x-mdrn-run-id": "run_1", "x-mdrn-scheduled-time": "2026-09-26T03:00:00Z", "x-mdrn-attempt": "2" } }));
  assert.deepEqual(run, { schedule: "sync", runId: "run_1", scheduledTime: "2026-09-26T03:00:00Z", attempt: 2 });
});

test("the fake keeps MDRN's rules: idempotent replay, key reuse, required headers, no credentials on a grant URL", async () => {
  const { fake, mdrn } = client();
  const first = await mdrn.db.create("tasks", { n: 1 }, { idempotencyKey: "same" });
  const again = await mdrn.db.create("tasks", { n: 1 }, { idempotencyKey: "same" });
  assert.equal(again.id, first.id);
  assert.equal(fake.collections.get("tasks").size, 1);
  await rejects(mdrn.db.create("tasks", { n: 2 }, { idempotencyKey: "same" }), 409, "CONFLICT");
  const raw = (path, init) => fake.fetch(`https://app.example${path}`, init);
  const headers = { authorization: "Bearer database-token", "mdrn-project": "project_one", "mdrn-environment": "sandbox", "content-type": "application/json" };
  assert.equal((await raw("/_mdrn/v1/database/collections/tasks/records", { method: "POST", headers, body: "{\"data\":{}}" })).status, 400);
  assert.equal((await raw(`/_mdrn/v1/database/collections/tasks/records/${first.id}`, { method: "DELETE", headers: { ...headers, "idempotency-key": "k" } })).status, 400);
  assert.equal((await raw("/_mdrn/v1/database/collections/tasks/records", { headers: { ...headers, authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await raw("/_mdrn/v1/database/collections/tasks/records", { headers: { ...headers, "mdrn-environment": "production" } })).status, 403);
  const upload = await mdrn.files.uploads.create({ filename: "a", contentType: "text/plain", bytes: 1, sha256: "a".repeat(64) });
  await mdrn.files.uploads.get(upload.id);
  const grant = await mdrn.files.uploads.part(upload.id, { partNumber: 1, size: 1 });
  const leaked = await fake.fetch(grant.url, { method: "PUT", headers: { ...grant.headers, authorization: "Bearer storage-token" }, body: bytes("a") });
  assert.equal(leaked.status, 403);
  const wrongSize = await fake.fetch(grant.url, { method: "PUT", headers: grant.headers, body: bytes("ab") });
  assert.equal(wrongSize.status, 400);
});
