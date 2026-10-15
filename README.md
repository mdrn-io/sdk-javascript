# MDRN SDK for JavaScript

`@mdrnio/sdk` is the client for the products a deployed MDRN app has (Database, Files, Mail) and
for who is calling it (Auth), for Workers and Node.js 20+. It has no dependencies. The same
surface exists for [Python, Go and Rust](https://mdrn.io/docs/sdk/).

## Install

```sh
npm install @mdrnio/sdk
```

## Quickstart

```javascript
import { Mdrn } from "@mdrnio/sdk";

export default {
  async fetch(request, env) {
    const mdrn = Mdrn.fromEnv(env);
    const user = mdrn.auth.user(request);
    if (!user) return new Response("Sign in first", { status: 401 });
    const note = await mdrn.db.create("notes", { owner: user.id, text: "hello" });
    const me = await mdrn.auth.me(request);
    if (me?.email) await mdrn.mail.send({ to: me.email, subject: "Saved", text: `Note ${note.id} saved.` });
    return Response.json(note);
  },
};
```

## Where the values come from

MDRN injects everything `fromEnv` reads into a release's environment: `MDRN_PROJECT_ID`,
`MDRN_ENVIRONMENT` (`sandbox` or `production`), one `MDRN_<PRODUCT>_URL` and
`MDRN_<PRODUCT>_TOKEN` per product switched on for the app (`DATABASE`, `STORAGE` for Files,
`MAIL`), and the `MDRN_PRODUCTS` service binding, which `fromEnv` sends product requests
through (a Worker cannot reach its own hostname with a global `fetch`). Anywhere else, give the
values yourself; requests then go through the global `fetch`:

```javascript
const mdrn = new Mdrn({ origin: "https://your-app.apps.mdrn.io", project, environment: "sandbox", tokens: { database, storage, mail } });
```

The tokens are workload credentials, never for a browser. `mdrn.enabled` lists the products
the client has (`db`, `files`, `mail`); a call on another throws `PRODUCT_NOT_ENABLED` with the
variable that is missing. Options: `fetcher` (replaces the binding or global fetch),
`timeoutMs` (10 000).

Every write takes `{ idempotencyKey, signal }`. A key is generated when you give none; give
one when you retry a change yourself and want it to happen once.

## Database

A record is a JSON object in a named collection, with an id MDRN assigns and a version that
grows by one on every change.

```javascript
const task = await mdrn.db.create("tasks", { title: "Write docs", done: false });
const same = await mdrn.db.get("tasks", task.id);              // null when there is none
const page = await mdrn.db.list("tasks", { limit: 50, cursor }); // { items, nextCursor }
const done = await mdrn.db.update("tasks", task.id, { done: true });
await mdrn.db.delete("tasks", task.id);
```

`update` merges the fields you give into the record (a shallow merge). Without `version` it
reads the record first, sends the change with the version it read as `If-Match`, and if the
record changed in between (409 `CONFLICT`) it reads and tries again, up to three more times.
With `{ version }` the change is sent once with that `If-Match` and a `CONFLICT` is yours to
handle; that is the right choice when the user saw the version they are changing. `delete`
works the same way. Keep cursors exactly as returned.

## Files

```javascript
const file = await mdrn.files.upload({ name: "photo.jpg", type: "image/jpeg", bytes });
const info = await mdrn.files.get(file.id);                   // null when there is none
const page = await mdrn.files.list({ limit: 50, cursor });
const { url, expiresAt } = await mdrn.files.downloadUrl(file.id); // a plain URL, 15 minutes
await mdrn.files.delete(file.id);
```

`upload` does the whole upload: the file's SHA-256, an upload session, one part of 16 MiB after
another sent to a grant URL with the grant's own headers (through the global `fetch`, never the
binding and never with the token), completion, and then waits for MDRN to verify the bytes
(polled every second, a minute at most) and answers the file in state `ready`. Pass
`{ wait: false }` to get it back after one read instead (usually still `verifying`) and check
`files.get` later. Bytes that do not match throw `FILE_REJECTED`.

The session itself is there too, for resuming an upload or for letting a browser PUT the
bytes: `mdrn.files.uploads.create`, `mdrn.files.uploads.get`, `mdrn.files.uploads.list`,
`mdrn.files.uploads.parts`, `mdrn.files.uploads.part`, `mdrn.files.uploads.complete`,
`mdrn.files.uploads.abort` and `mdrn.files.operation(id)`. Ask for a part grant in your
backend and hand the browser the grant's `url`, `method` and `headers`.

## Mail

```javascript
await mdrn.mail.send({ to: "ada@example.com", subject: "Welcome", text: "Hello Ada", html: "<p>Hello Ada</p>" });
await mdrn.mail.send({ to: "ada@example.com", template: "welcome" });
```

A message is either your own content (`subject` and `text`, `html` if wanted) or a `template`
of the project and environment, which supplies all three; giving a template together with
any of them throws a `TypeError` before anything is sent. `attachments` (up to four,
`{ filename, type, content }` with base64 content) and `senderId` (a verified sender domain;
omit it when the workspace has one) go with either. The answer is `{ id, state: "queued" }`:
accepted, not yet delivered. A Sandbox environment delivers like Production: to anyone, from
a verified sender.

## Auth

MDRN's Proxy deletes every `x-mdrn-*` header a client sent and, for a signed-in visitor, adds
`x-mdrn-user-id` and `x-mdrn-identity-token`. Your Worker is reachable only through the Proxy,
so these can be trusted there (not under `wrangler dev`, where anyone can send them).

```javascript
const user = mdrn.auth.user(request);   // { id, token } or null
const me = await mdrn.auth.me(request); // { id, email?, name?, metadataState, ... } or null
```

`me` asks MDRN Identity (`GET /v1/auth/me` through the binding, with the visitor's short-lived
token) and answers null when nobody is signed in or the session has ended.

### Sign-in from the browser

With `loginPage` set to `own` in the Auth configuration, your app serves the sign-in page
itself, and `@mdrnio/sdk/browser` makes that page's calls: no dependencies, nothing of the
server-side client, so it runs in any browser, bundled with your page or served from
`node_modules/@mdrnio/sdk/src/browser.js`.

```javascript
import { signIn, session, signOut } from "@mdrnio/sdk/browser";

const auth = signIn({ returnPath: "/" }); // reads ?transactionId= and ?reason= from the address, and removes them
auth.message;                             // a sentence to show when MDRN sent the visitor back, else null
await auth.sendCode(email);               // starts the sign-in unless one is resumed, emails a six-digit code
await auth.resendCode();                  // the same address again; MDRN allows one code a minute
await auth.verifyCode(code);              // signs in and goes to returnPath; { navigate: false } answers { redirectUrl }
await auth.continueWith("google");        // or "github": the browser goes to the provider and comes back signed in
await session();                          // { state: "authenticated", user, expiresAt } or { state: "anonymous", user: null }
await signOut();                          // ends the session on this address
```

A refused call throws a `SignInError`: `code` is MDRN's (`RATE_LIMITED`, `ACCOUNT_DISABLED`,
`EMAIL_UNDELIVERABLE`, `EMAIL_PAUSED`, …) and `message` a sentence for the visitor. The calls go
to the app's own address with the browser's cookies and the CSRF tokens MDRN asks for; a test
gives `signIn`, `session` and `signOut` their own `fetch`, `location` and `history`.

## Schedules

A schedule declared in `mdrn.jsonc` arrives as a `POST` to its path. `scheduledRun(request)`
returns the run, or `null` for any other request. The run id is the same on every attempt of
one run, so use it as the idempotency key of the work.

```javascript
import { scheduledRun } from "@mdrnio/sdk";
const run = scheduledRun(request);
if (url.pathname === "/tasks/digest" && run) await sendDigest(run.runId);
```

## Errors

Every failed call throws `MdrnError` with `status` (the HTTP status, 0 when no response was
received), `code`, `message` (MDRN's, for your logs) and `details` (the response body).

| `code` | `status` | When |
| --- | --- | --- |
| `PRODUCT_NOT_ENABLED` | 0 | The product has no URL or token in this environment |
| `TIMEOUT` | 0 | No answer within 10 seconds (`timeoutMs`) |
| `NETWORK_ERROR` | 0 | The request could not be sent |
| `UNEXPECTED_REDIRECT` | 3xx | MDRN answered with a redirect, which is never followed |
| `HTTP_ERROR` | 4xx, 5xx | A failure without MDRN's error envelope |
| `INVALID_REQUEST`, `CONFLICT`, `NOT_FOUND`, `TEMPLATE_NOT_FOUND`, ... | 4xx, 5xx | The code from MDRN's envelope |
| `UPLOAD_FAILED`, `FILE_REJECTED` | 0 | An upload did not accept parts, or MDRN rejected the bytes |

`get` methods answer `null` for a 404 instead of throwing. `code` comes from MDRN's envelope
(`{ error: { code, message } }`), or is `HTTP_ERROR` when the body is not one. A redirect is
`UNEXPECTED_REDIRECT`: never followed, so the token cannot reach another origin. Nothing is
retried except the conflict loop of `update` and `delete`. The product URLs must be https;
plain http is accepted only to `localhost`, `127.0.0.1` or `[::1]`.

```javascript
try { await mdrn.db.update("tasks", id, patch, { version }); }
catch (error) { if (error instanceof MdrnError && error.code === "CONFLICT") { /* reload */ } else throw error; }
```

## Testing

`@mdrnio/sdk/fake` is an in-memory MDRN: the 19 operations with the real response shapes, status
codes and error codes, idempotent replay, upload sessions with grants, a mail queue with the
template rule, `/v1/auth/me` for a signed-in user, and a log of every request.

```javascript
import { createFakeMdrn } from "@mdrnio/sdk/fake";
const fake = createFakeMdrn();
const mdrn = Mdrn.fromEnv(fake.env, { transfer: fake.fetch }); // transfer: grant URLs, in Node
const headers = fake.signIn("user_1", "user@example.com");       // the two Proxy headers
await worker.fetch(new Request("https://app.example/", { headers }), fake.env);
fake.collections.get("notes"); fake.sent; fake.log;
```

In workerd (Miniflare) give `fake.fetch` as the `MDRN_PRODUCTS` service binding and as the
`outboundService`. Three collection names reach error paths: `broken` (502 without an
envelope), `redirected` (307), `contended` (every read bumps the version).
[`examples/round-trip.js`](examples/round-trip.js) is a Worker that uses most of the SDK;
`npm test` runs it in Node and in workerd against the fake.

## Versions

`0.3.0`, shared with the other languages (`sdk/VERSION`, `sdk/CHANGELOG.md`). All four SDKs
produce the same transcript against the same scenarios: `sdk/conformance/`.

## Contributing

This repository is a mirror: the code is published here from MDRN's main repository on every
release, where it is tested against the API contract together with the other SDKs. Issues are
welcome here. Pull requests are reviewed here and merged in the main repository, from where the
next release brings them back.
