// The JavaScript conformance runner: every scenario of sdk/conformance/scenarios.md, against
// the MDRN at MDRN_ORIGIN, printed as the transcript that must equal
// sdk/conformance/expected.json. `node sdk/conformance/run.mjs` starts the server and runs it
// so, and compares the requests it sent with the other languages'. Under `node --test` (no
// MDRN_ORIGIN) it starts the server itself and asserts the transcript as one test.
import { Mdrn, MdrnError, scheduledRun } from "../src/index.js";

const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])])) : value;
const failure = (error) => error instanceof MdrnError ? { error: { status: error.status, code: error.code } } : { refused: true };
const bytes = (text) => new TextEncoder().encode(text);
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function conformance({ origin, project, environment, tokens = {}, user = {} }) {
  const base = { project: project || "project_one", environment: environment || "sandbox" };
  tokens = { database: tokens.database || "database-token", storage: tokens.storage || "storage-token", mail: tokens.mail || "mail-token" };
  const USER = { id: user.id || "user_1", email: "user_1@example.com", token: user.token || "identity-token-1" };
  const mdrn = new Mdrn({ origin, ...base, tokens });
  const request = (headers = {}) => new Request(`${origin}/account`, { headers });
  const transcript = {};
  async function scenario(name, run) {
    try {
      transcript[name] = await run();
    } catch (error) {
      // A refusal is expected in some scenarios; MDRN_CONFORMANCE_DEBUG shows which error it was.
      if (!(error instanceof MdrnError) && process.env.MDRN_CONFORMANCE_DEBUG) console.error(`${name}: ${error.stack ?? error}`);
      transcript[name] = failure(error);
    }
  }
  const attempt = (run) => run().then(() => ({ accepted: true }), (error) => failure(error));

  // Database
  let one, two;
  await scenario("db.create", async () => {
    one = await mdrn.db.create("tasks", { title: "one", done: false }, { idempotencyKey: "create-one" });
    return { collection: one.collection, version: one.version, data: one.data };
  });
  await scenario("db.create.replay", async () => {
    const again = await mdrn.db.create("tasks", { title: "one", done: false }, { idempotencyKey: "create-one" });
    return { sameId: again.id === one.id, version: again.version };
  });
  await scenario("db.get", async () => {
    const record = await mdrn.db.get("tasks", one.id);
    return { found: record !== null, version: record.version, data: record.data };
  });
  await scenario("db.get.missing", () => mdrn.db.get("tasks", "rec_missing"));
  await scenario("db.list.pages", async () => {
    two = await mdrn.db.create("tasks", { title: "two", done: false }, { idempotencyKey: "create-two" });
    await mdrn.db.create("tasks", { title: "three", done: false }, { idempotencyKey: "create-three" });
    const first = await mdrn.db.list("tasks", { limit: 2 });
    const second = await mdrn.db.list("tasks", { limit: 2, cursor: first.nextCursor });
    return { first: first.items.map((r) => r.data.title), second: second.items.map((r) => r.data.title), more: [first.nextCursor !== null, second.nextCursor !== null] };
  });
  await scenario("db.update.explicit", async () => {
    const record = await mdrn.db.update("tasks", one.id, { done: true }, { version: 1, idempotencyKey: "update-one" });
    return { version: record.version, data: record.data };
  });
  await scenario("db.update.stale", () => mdrn.db.update("tasks", one.id, { done: false }, { version: 1 }));
  await scenario("db.update.implicit", async () => {
    const record = await mdrn.db.update("tasks", one.id, { title: "one!" });
    return { version: record.version, data: record.data };
  });
  await scenario("db.update.contended.once", async () => {
    const created = await mdrn.db.create("contended-once", { n: 1 }, { idempotencyKey: "create-contended-once" });
    const record = await mdrn.db.update("contended-once", created.id, { n: 2 });
    return { version: record.version, data: record.data };
  });
  await scenario("db.update.contended", async () => {
    const created = await mdrn.db.create("contended", { n: 1 }, { idempotencyKey: "create-contended" });
    return mdrn.db.update("contended", created.id, { n: 2 });
  });
  await scenario("db.delete.explicit", async () => {
    await mdrn.db.delete("tasks", one.id, { version: 3, idempotencyKey: "delete-one" });
    return { gone: (await mdrn.db.get("tasks", one.id)) === null };
  });
  await scenario("db.delete.implicit", async () => {
    const four = await mdrn.db.create("tasks", { title: "four", done: false }, { idempotencyKey: "create-four" });
    await mdrn.db.delete("tasks", four.id);
    return { gone: (await mdrn.db.get("tasks", four.id)) === null };
  });
  await scenario("db.delete.stale", () => mdrn.db.delete("tasks", two.id, { version: 5 }));
  await scenario("db.error.envelope", () => mdrn.db.list("tasks", { limit: 1000 }));
  await scenario("db.error.noEnvelope", () => mdrn.db.list("broken"));
  await scenario("db.error.redirect", () => mdrn.db.list("redirected"));

  // Client
  await scenario("client.origin", async () => {
    const construct = (o) => attempt(async () => new Mdrn({ origin: o, ...base, tokens }));
    return { plainHttp: await construct("http://app.example"), loopbackHttp: await construct("http://127.0.0.1:1"), https: await construct("https://app.example") };
  });
  await scenario("client.notEnabled", async () => {
    const only = new Mdrn({ origin, ...base, tokens: { database: tokens.database } });
    return { enabled: only.enabled, files: await attempt(() => only.files.get("obj_x")), mail: await attempt(() => only.mail.send({ to: USER.email, subject: "Hi", text: "Hello" })) };
  });

  // Files
  const view = (file) => ({ filename: file.filename, contentType: file.contentType, bytes: file.bytes, sha256: file.sha256, state: file.state });
  let hello;
  await scenario("files.upload.onePart", async () => view(hello = await mdrn.files.upload({ name: "hello.txt", type: "text/plain", bytes: bytes("hello") }, { idempotencyKey: "upload-hello" })));
  await scenario("files.upload.twoParts", async () => view(await mdrn.files.upload({ name: "hello.bin", bytes: bytes("hello, world") }, { idempotencyKey: "upload-world" })));
  await scenario("files.get", async () => {
    const file = await mdrn.files.get(hello.id);
    return { found: file !== null, state: file.state, bytes: file.bytes };
  });
  await scenario("files.get.missing", () => mdrn.files.get("obj_missing"));
  await scenario("files.list", async () => {
    const page = await mdrn.files.list({ limit: 10 });
    return { filenames: page.items.map((f) => f.filename), more: page.nextCursor !== null };
  });
  await scenario("files.downloadUrl", async () => {
    const { url, expiresAt } = await mdrn.files.downloadUrl(hello.id, { idempotencyKey: "download-hello" });
    const response = await fetch(url);
    return { urlUnderOrigin: url.startsWith(origin), hasExpiresAt: typeof expiresAt === "string" && expiresAt.length > 0, downloaded: await response.text() };
  });
  await scenario("files.delete", async () => {
    await mdrn.files.delete(hello.id, { idempotencyKey: "delete-hello" });
    return { gone: (await mdrn.files.get(hello.id)) === null };
  });
  await scenario("files.uploads.manual", async () => {
    const data = bytes("manual");
    const sha256 = hex(await crypto.subtle.digest("SHA-256", data));
    const created = await mdrn.files.uploads.create({ filename: "manual.txt", contentType: "text/plain", bytes: data.byteLength, sha256 }, { idempotencyKey: "upload-manual" });
    const polled = await mdrn.files.uploads.get(created.id);
    const grant = await mdrn.files.uploads.part(created.id, { partNumber: 1, size: data.byteLength }, { idempotencyKey: "upload-manual-part-1" });
    const put = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: data });
    const { etag } = await put.json();
    const parts = await mdrn.files.uploads.parts(created.id);
    const completion = await mdrn.files.uploads.complete(created.id, [{ partNumber: 1, etag }], { idempotencyKey: "upload-manual-complete" });
    const operation = await mdrn.files.operation(completion.operationId);
    const file = await mdrn.files.get(completion.id);
    const uploads = await mdrn.files.uploads.list({ limit: 10 });
    return { created: created.state, polled: polled.state, grantMethod: grant.method, putStatus: put.status, parts: parts.items.map((p) => p.partNumber), completion: completion.state, operation: operation.state, file: file.state, uploads: uploads.items.length };
  });
  await scenario("files.uploads.abort", async () => {
    const created = await mdrn.files.uploads.create({ filename: "abandoned.txt", contentType: "text/plain", bytes: 1, sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" }, { idempotencyKey: "upload-abandoned" });
    await mdrn.files.uploads.abort(created.id, { idempotencyKey: "abort-abandoned" });
    return { state: (await mdrn.files.uploads.get(created.id)).state };
  });

  // Mail
  await scenario("mail.plain", async () => ({ state: (await mdrn.mail.send({ to: USER.email, subject: "Hi", text: "Hello" }, { idempotencyKey: "mail-plain" })).state }));
  await scenario("mail.html", async () => ({ state: (await mdrn.mail.send({ to: USER.email, subject: "Hi", text: "Hello", html: "<p>Hello</p>" }, { idempotencyKey: "mail-html" })).state }));
  await scenario("mail.template", async () => ({ state: (await mdrn.mail.send({ to: USER.email, template: "welcome" }, { idempotencyKey: "mail-template" })).state }));
  await scenario("mail.template.conflict", () => mdrn.mail.send({ to: USER.email, template: "welcome", subject: "Hi" }, { idempotencyKey: "mail-conflict" }));
  await scenario("mail.template.missing", () => mdrn.mail.send({ to: USER.email, template: "nope" }, { idempotencyKey: "mail-missing" }));

  // Auth
  const signedIn = { "x-mdrn-user-id": USER.id, "x-mdrn-identity-token": USER.token };
  await scenario("auth.user.present", async () => {
    const found = mdrn.auth.user(request(signedIn));
    return { id: found.id, token: found.token };
  });
  await scenario("auth.user.absent", async () => mdrn.auth.user(request()));
  await scenario("auth.user.malformed", async () => mdrn.auth.user(request({ "x-mdrn-user-id": "not valid!", "x-mdrn-identity-token": USER.token })));
  await scenario("auth.me", () => mdrn.auth.me(request(signedIn)));
  await scenario("auth.me.absent", () => mdrn.auth.me(request()));
  await scenario("auth.me.expired", () => mdrn.auth.me(request({ "x-mdrn-user-id": USER.id, "x-mdrn-identity-token": "expired-token" })));

  // Schedules
  await scenario("schedule.present", async () => scheduledRun(request({ "x-mdrn-schedule": "digest", "x-mdrn-run-id": "run_1", "x-mdrn-scheduled-time": "2026-09-26T03:00:00Z", "x-mdrn-attempt": "2" })));
  await scenario("schedule.absent", async () => scheduledRun(request()));

  return sorted(transcript);
}

const env = process.env;
if (env.MDRN_ORIGIN) {
  const transcript = await conformance({
    origin: env.MDRN_ORIGIN, project: env.MDRN_PROJECT, environment: env.MDRN_ENVIRONMENT,
    tokens: { database: env.MDRN_DATABASE_TOKEN, storage: env.MDRN_STORAGE_TOKEN, mail: env.MDRN_MAIL_TOKEN },
    user: { id: env.MDRN_USER_ID, token: env.MDRN_IDENTITY_TOKEN },
  });
  process.stdout.write(JSON.stringify(transcript, null, 2) + "\n");
} else {
  const [{ default: test }, { default: assert }, { readFile }, { startServer }] = await Promise.all([import("node:test"), import("node:assert/strict"), import("node:fs/promises"), import("../../conformance/server.mjs")]);
  test("the SDK produces sdk/conformance/expected.json against the conformance server", async () => {
    const expected = JSON.parse(await readFile(new URL("../../conformance/expected.json", import.meta.url), "utf8"));
    const { origin, close } = await startServer();
    try {
      assert.deepEqual(await conformance({ origin }), expected);
    } finally {
      await close();
    }
  });
}
