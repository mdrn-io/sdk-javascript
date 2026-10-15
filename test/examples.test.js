// Runs examples/round-trip.js against the fake MDRN: in Node with the fake as the client's
// fetcher, and in workerd as the deployed Worker it is, through the MDRN_PRODUCTS binding.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Mdrn } from "../src/index.js";
import { createFakeMdrn } from "../src/fake.js";
import { roundTrip } from "../examples/round-trip.js";

const CONTENT = "Hello from the MDRN JavaScript SDK\n";
const expected = {
  record: { versions: [1, 2], deleted: true },
  file: { bytes: CONTENT.length, downloaded: CONTENT, deleted: true },
  mail: { state: "queued" },
};
const stripIds = ({ record: { id: _r, ...record }, file: { id: _f, ...file }, mail: { id: _m, requestId: _q, ...mail } }) => ({ record, file, mail });
// The example's own fetch of the download URL goes to the fake too.
const STEPS = 15;

test("the round-trip example creates, reads, updates and deletes a record, uploads, downloads and deletes a file, and mails the visitor", async () => {
  const fake = createFakeMdrn();
  const mdrn = Mdrn.fromEnv(fake.env, { transfer: fake.fetch });
  const user = mdrn.auth.user(new Request("https://app.example/", { headers: fake.signIn("user_1", "user@example.com") }));
  const result = await roundTrip(mdrn, user, { download: (url) => fake.fetch(url) });
  assert.deepEqual(stripIds(result), expected);
  assert.equal(fake.log.length, STEPS);
  assert.equal(fake.sent[0].recipient, "user@example.com");
  assert.equal(fake.collections.get("notes").size, 0);
});

let Miniflare, convert;
try { ({ Miniflare, convertV4MiniflareOptions: convert } = await import("miniflare")); } catch { /* not installed */ }
const options = (o) => (convert ? convert({ workers: [o] }) : o);

test("the round-trip example runs as a Worker in workerd", { skip: !Miniflare && "miniflare is not installed" }, async () => {
  const fake = createFakeMdrn();
  const { MDRN_PRODUCTS, ...bindings } = fake.env;
  const mf = new Miniflare(options({
    name: "app",
    compatibilityDate: "2026-09-16",
    modules: [
      // The example as written, with its package import pointed at the module beside it.
      { type: "ESModule", path: "worker.js", contents: (await readFile(new URL("../examples/round-trip.js", import.meta.url), "utf8")).replace('from "@mdrnio/sdk"', 'from "./index.js"') },
      { type: "ESModule", path: "index.js", contents: await readFile(new URL("../src/index.js", import.meta.url), "utf8") },
    ],
    bindings,
    serviceBindings: { MDRN_PRODUCTS: fake.fetch },
    // The grant URLs are reached with the Worker's global fetch.
    outboundService: fake.fetch,
  }));
  try {
    assert.equal((await mf.dispatchFetch("https://app.example/")).status, 405);
    const response = await mf.dispatchFetch("https://app.example/", { method: "POST", headers: fake.signIn("user_1", "user@example.com") });
    assert.deepEqual(stripIds(await response.json()), expected);
    assert.equal(fake.log.length, STEPS);
  } finally {
    await mf.dispose();
  }
});
