// A Worker that makes one Database record round trip (create, read, update, delete), one Files
// round trip (upload a small file, wait until it is verified, download it, delete it) and, when
// Mail is enabled, sends the signed-in visitor one message. Deploy it as an app with Database
// and Files given to it, then send it a POST: `curl -X POST https://<your app>/`. It answers
// with what it did as JSON. sdk/javascript/test/examples.test.js runs it in Node and in workerd
// against the fake MDRN of `@mdrnio/sdk/fake`.
import { Mdrn } from "@mdrnio/sdk";

const CONTENT = new TextEncoder().encode("Hello from the MDRN JavaScript SDK\n");

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("Send a POST to run the example.\n", { status: 405, headers: { Allow: "POST" } });
    const mdrn = Mdrn.fromEnv(env);
    return Response.json(await roundTrip(mdrn, mdrn.auth.user(request)));
  },
};

// `download` fetches a download URL; it is the global fetch unless a test replaces it.
export async function roundTrip(mdrn, user = null, { download = (url) => fetch(url) } = {}) {
  const created = await mdrn.db.create("notes", { text: "hello" });
  const read = await mdrn.db.get("notes", created.id);
  const updated = await mdrn.db.update("notes", read.id, { text: "hello again" }, { version: read.version });
  await mdrn.db.delete("notes", updated.id, { version: updated.version });

  const file = await mdrn.files.upload({ name: "hello.txt", type: "text/plain", bytes: CONTENT });
  const { url } = await mdrn.files.downloadUrl(file.id);
  // A download URL is a plain URL: a global fetch, no token.
  const received = await download(url);
  if (!received.ok) throw new Error(`The download failed with HTTP ${received.status}`);
  const text = await received.text();
  await mdrn.files.delete(file.id);

  const result = {
    record: { id: created.id, versions: [created.version, updated.version], deleted: true },
    file: { id: file.id, bytes: file.bytes, downloaded: text, deleted: true },
  };
  if (user && mdrn.enabled.includes("mail")) {
    const me = await mdrn.auth.me(new Request("https://app.example/", { headers: { "x-mdrn-user-id": user.id, "x-mdrn-identity-token": user.token } }));
    if (me?.email) result.mail = await mdrn.mail.send({ to: me.email, subject: "Round trip", text: "The example ran." });
  }
  return result;
}
