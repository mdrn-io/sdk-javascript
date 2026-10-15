// Runs the SDK inside workerd, the runtime of a deployed Worker, through a service binding as
// Mdrn.fromEnv uses it, with the fake MDRN answering the binding. Skipped when Miniflare is not
// installed (it comes with the workspace).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeMdrn } from "../src/fake.js";

let Miniflare, convert;
try { ({ Miniflare, convertV4MiniflareOptions: convert } = await import("miniflare")); } catch { /* not installed */ }
// Miniflare 5 takes a workers array; the v4 single-worker shape is converted when it can be.
const options = (o) => (convert ? convert({ workers: [o] }) : o);

const worker = `
import { Mdrn } from "./index.js";
export default {
  async fetch(request, env) {
    const mdrn = Mdrn.fromEnv(env);
    try {
      const collection = new URL(request.url).pathname.slice(1);
      if (collection === "me") return Response.json({ ok: await mdrn.auth.me(request) });
      return Response.json({ ok: await mdrn.db.list(collection), enabled: mdrn.enabled });
    } catch (error) {
      return Response.json({ error: { name: error.name, status: error.status, code: error.code, message: error.message } });
    }
  },
};`;

test("calls MDRN from a Worker through the products binding, reads the visitor, and refuses a redirect there", { skip: !Miniflare && "miniflare is not installed" }, async () => {
  const fake = createFakeMdrn();
  const { MDRN_PRODUCTS, MDRN_MAIL_URL, MDRN_MAIL_TOKEN, ...bindings } = fake.env;
  const mf = new Miniflare(options({
    name: "app",
    compatibilityDate: "2026-09-16",
    modules: [
      { type: "ESModule", path: "worker.js", contents: worker },
      { type: "ESModule", path: "index.js", contents: await readFile(new URL("../src/index.js", import.meta.url), "utf8") },
    ],
    bindings,
    serviceBindings: { MDRN_PRODUCTS: fake.fetch },
  }));
  try {
    const ok = await (await mf.dispatchFetch("https://app.example/tasks")).json();
    assert.deepEqual(ok, { ok: { items: [], nextCursor: null }, enabled: ["db", "files"] });
    assert.equal(fake.log[0].path, "/_mdrn/v1/database/collections/tasks/records");
    assert.equal(fake.log[0].headers.authorization, "Bearer database-token");
    const me = await (await mf.dispatchFetch("https://app.example/me", { headers: fake.signIn("user_1", "user@example.com") })).json();
    assert.deepEqual(me, { ok: { id: "user_1", email: "user@example.com", metadataState: "not_configured" } });
    assert.equal(fake.log[1].path, "/v1/auth/me");
    const moved = await (await mf.dispatchFetch("https://app.example/redirected")).json();
    assert.equal(moved.error.name, "MdrnError");
    assert.equal(moved.error.status, 307);
    assert.equal(moved.error.code, "UNEXPECTED_REDIRECT");
    assert.equal(fake.log.length, 3);
  } finally {
    await mf.dispose();
  }
});
