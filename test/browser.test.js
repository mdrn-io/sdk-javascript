// The browser sign-in client against a fake of MDRN's sign-in calls on the app's own address:
// what it sends, in what order, where it sends the browser, and what it says when MDRN refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { SignInError, session, signIn, signOut } from "../src/browser.js";

const TX = "a".repeat(64);
const TX2 = "b".repeat(64);

/** A page at `href` on a fake MDRN: `log` is every call as "METHOD path [csrf]" with its body,
 * `navigated` where location.assign went, `address` what the page's address became. Replies
 * are the fake's own unless `replies` has one for "METHOD path". */
function page({ href = "https://shop.example/login", replies = {}, started = TX } = {}) {
  const state = { log: [], navigated: null, address: href, platformCsrfCalls: 0 };
  const reply = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const key = `${method} ${path}`;
    state.log.push({ call: key, csrf: init.headers?.["X-CSRF-Token"], body: init.body === undefined ? undefined : JSON.parse(init.body), credentials: init.credentials, contentType: init.headers?.["Content-Type"] });
    const given = replies[key];
    if (given) { const next = Array.isArray(given) ? given.shift() : given; if (next) return reply(next.status, next.json); }
    if (key === "GET /_mdrn/v1/platform/csrf") { state.platformCsrfCalls += 1; return reply(200, { csrfToken: "platform-csrf" }); }
    if (key === "POST /_mdrn/v1/auth/start") return reply(200, { transactionId: started, url: `https://shop.example/v1/auth/transactions/${started}` });
    if (key === `GET /v1/auth/transactions/${started}/csrf` || key === `GET /v1/auth/transactions/${TX}/csrf`) return reply(200, { csrfToken: `tx-csrf-${path.split("/")[4].slice(0, 1)}` });
    if (key.endsWith("/email-otp/send")) return reply(202, { ok: true });
    if (key.endsWith("/email-otp/verify")) return reply(200, { redirectUrl: "/" });
    if (key.endsWith("/complete")) return reply(400, { error: { code: "transaction_not_proved" } });
    if (key === "GET /_mdrn/v1/auth/session") return reply(200, { state: "anonymous", user: null });
    if (key === "DELETE /_mdrn/v1/auth/session") return reply(204);
    return reply(404, { error: { code: "not_found" } });
  };
  const location = { get href() { return state.address; }, origin: new URL(href).origin, assign: (url) => { state.navigated = url; } };
  const history = { replaceState: (_state, _title, url) => { state.address = url; } };
  return { state, options: { fetch, location, history } };
}
const calls = (state) => state.log.map((entry) => entry.call);

test("sendCode starts a sign-in with the platform token, reads the sign-in's own token and sends the code; verifyCode verifies and navigates", async () => {
  const { state, options } = page();
  const auth = signIn({ returnPath: "/app", ...options });
  assert.equal(auth.reason, null);
  assert.equal(auth.message, null);
  assert.equal(state.address, "https://shop.example/login");
  await auth.sendCode(" ana@example.com ");
  assert.deepEqual(calls(state), ["GET /_mdrn/v1/platform/csrf", "POST /_mdrn/v1/auth/start", `GET /v1/auth/transactions/${TX}/csrf`, `POST /v1/auth/transactions/${TX}/email-otp/send`]);
  const [csrf, start, , send] = state.log;
  assert.equal(csrf.credentials, "same-origin");
  assert.equal(start.csrf, "platform-csrf");
  assert.equal(start.contentType, "application/json");
  assert.deepEqual(start.body, { returnPath: "/app", method: "email_otp" });
  assert.equal(send.csrf, "tx-csrf-a");
  assert.deepEqual(send.body, { email: "ana@example.com" });
  const result = await auth.verifyCode("123456");
  assert.deepEqual(result, { redirectUrl: "/" });
  assert.deepEqual(calls(state).slice(4), [`POST /v1/auth/transactions/${TX}/email-otp/verify`]);
  assert.deepEqual(state.log[4].body, { code: "123456" });
  assert.equal(state.navigated, "https://shop.example/");
});

test("resendCode sends to the same address again, and verifyCode with navigate false only answers", async () => {
  const { state, options } = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/verify`]: { status: 200, json: { redirectUrl: "https://shop.example/app?x=1" } } } });
  const auth = signIn(options);
  await assert.rejects(() => auth.resendCode(), /sendCode first/);
  await auth.sendCode("ana@example.com");
  await auth.resendCode();
  const sends = state.log.filter((entry) => entry.call.endsWith("/email-otp/send"));
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1].body, { email: "ana@example.com" });
  assert.deepEqual(await auth.verifyCode("000000", { navigate: false }), { redirectUrl: "https://shop.example/app?x=1" });
  assert.equal(state.navigated, null);
  assert.equal(state.log.filter((entry) => entry.call === "POST /_mdrn/v1/auth/start").length, 1, "one sign-in for the whole page");
});

test("a redirect off the page's origin is refused, never followed", async () => {
  const { state, options } = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/verify`]: { status: 200, json: { redirectUrl: "https://evil.example/" } } } });
  const auth = signIn(options);
  await auth.sendCode("ana@example.com");
  await assert.rejects(() => auth.verifyCode("123456"), (error) => error instanceof SignInError && error.code === "INVALID_DESTINATION");
  assert.equal(state.navigated, null);
});

test("a sign-in named by ?transactionId= is resumed, not started, and the id leaves the address", async () => {
  const { state, options } = page({ href: `https://shop.example/login?transactionId=${TX}&next=1` });
  const auth = signIn(options);
  assert.equal(state.address, "https://shop.example/login?next=1");
  await auth.sendCode("ana@example.com");
  assert.deepEqual(calls(state), [`GET /v1/auth/transactions/${TX}/csrf`, `POST /v1/auth/transactions/${TX}/email-otp/send`]);
  assert.equal(auth.reason, null);
});

test("a transactionId that is not one is ignored", async () => {
  const { state, options } = page({ href: "https://shop.example/login?transactionId=../x" });
  const auth = signIn(options);
  await auth.sendCode("ana@example.com");
  assert.equal(calls(state)[1], "POST /_mdrn/v1/auth/start");
});

const REASONS = {
  provider_cancelled: ["Sign-in was cancelled. Choose a way to sign in.", true],
  unavailable: ["Sign-in is unavailable right now. Try again in a moment.", true],
  provider_attempts_exhausted: ["That sign-in was tried too many times. Choose a way to sign in to start again.", false],
  transaction_expired: ["That sign-in expired. Choose a way to sign in to start again.", false],
  transaction_already_proved: ["That sign-in already finished in another tab or window. Choose a way to sign in to start again.", false],
  account_disabled: ["Account disabled", false],
};
for (const [reason, [message, kept]] of Object.entries(REASONS)) {
  test(`?reason=${reason} is said in a sentence and ${kept ? "keeps" : "drops"} the sign-in it came with`, async () => {
    const { state, options } = page({ href: `https://shop.example/login?reason=${reason}&transactionId=${TX}`, started: TX2 });
    const auth = signIn(options);
    assert.equal(auth.reason, reason);
    assert.equal(auth.message, message);
    assert.equal(state.address, "https://shop.example/login");
    await auth.sendCode("ana@example.com");
    const sent = calls(state);
    if (kept) assert.deepEqual(sent, [`GET /v1/auth/transactions/${TX}/csrf`, `POST /v1/auth/transactions/${TX}/email-otp/send`]);
    else assert.deepEqual(sent, ["GET /_mdrn/v1/platform/csrf", "POST /_mdrn/v1/auth/start", `GET /v1/auth/transactions/${TX2}/csrf`, `POST /v1/auth/transactions/${TX2}/email-otp/send`]);
  });
}

test("a reason MDRN never sends, or one named like an Object property, is no reason, and drops the sign-in", async () => {
  for (const reason of ["constructor", "__proto__", "later_reason"]) {
    const { state, options } = page({ href: `https://shop.example/login?reason=${reason}&transactionId=${TX}`, started: TX2 });
    const auth = signIn(options);
    assert.equal(auth.reason, null);
    assert.equal(auth.message, null);
    assert.equal(state.address, "https://shop.example/login");
    await auth.sendCode("ana@example.com");
    assert.equal(calls(state)[1], "POST /_mdrn/v1/auth/start");
  }
});

test("continueWith starts a sign-in for the provider and sends the browser to its route; a resumed one goes straight there", async () => {
  const fresh = page();
  const auth = signIn(fresh.options);
  await auth.continueWith("google");
  assert.deepEqual(calls(fresh.state), ["GET /_mdrn/v1/platform/csrf", "POST /_mdrn/v1/auth/start", `GET /v1/auth/transactions/${TX}/csrf`]);
  assert.deepEqual(fresh.state.log[1].body, { returnPath: "/", method: "google" });
  assert.equal(fresh.state.navigated, `https://shop.example/v1/auth/transactions/${TX}/google`);
  const resumed = page({ href: `https://shop.example/login?reason=provider_cancelled&transactionId=${TX}` });
  await signIn(resumed.options).continueWith("github");
  assert.deepEqual(calls(resumed.state), [`GET /v1/auth/transactions/${TX}/csrf`]);
  assert.equal(resumed.state.navigated, `https://shop.example/v1/auth/transactions/${TX}/github`);
  await assert.rejects(() => auth.continueWith("facebook"), TypeError);
});

test("a stale pre-sign-in cookie: a 401 on the platform token is read once more", async () => {
  const { state, options } = page({ replies: { "GET /_mdrn/v1/platform/csrf": [{ status: 401, json: { error: { code: "invalid_session" } } }] } });
  await signIn(options).sendCode("ana@example.com");
  assert.equal(state.platformCsrfCalls, 1);
  assert.equal(calls(state).filter((call) => call === "GET /_mdrn/v1/platform/csrf").length, 2);
  assert.equal(state.log[2].call, "POST /_mdrn/v1/auth/start");
  assert.equal(state.log[2].csrf, "platform-csrf");
});

test("MDRN's refusals are SignInErrors with its code and a sentence for the visitor", async () => {
  const refusal = (code, status = 400) => ({ status, json: { error: { code } } });
  const cases = [
    ["RATE_LIMITED", 429, "Please wait before trying again."],
    ["ACCOUNT_DISABLED", 403, "Account disabled"],
    ["EMAIL_UNDELIVERABLE", 400, "That address cannot receive email. Check it and try again."],
    ["EMAIL_PAUSED", 503, "This app cannot send sign-in emails right now. Try another way to sign in, or contact the app."],
    ["something_else", 400, "Unable to continue. Check your code or restart sign-in."],
  ];
  for (const [code, status, message] of cases) {
    const { options } = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/send`]: refusal(code, status) } });
    await assert.rejects(() => signIn(options).sendCode("ana@example.com"), (error) => error instanceof SignInError && error.code === code && error.status === status && error.message === message);
  }
  const { options } = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/send`]: { status: 502 } } });
  await assert.rejects(() => signIn(options).sendCode("ana@example.com"), (error) => error.code === "HTTP_ERROR" && error.status === 502);
  const offline = page();
  offline.options.fetch = async () => { throw new TypeError("failed to fetch"); };
  await assert.rejects(() => signIn(offline.options).sendCode("ana@example.com"), (error) => error instanceof SignInError && error.code === "NETWORK_ERROR" && error.status === 0);
});

test("a wrong code is the verify refusal; a code already verified is finished through complete", async () => {
  const wrong = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/verify`]: { status: 400, json: { error: { code: "invalid_code" } } } } });
  const auth = signIn(wrong.options);
  await auth.sendCode("ana@example.com");
  await assert.rejects(() => auth.verifyCode("111111"), (error) => error.code === "invalid_code" && error.message === "Unable to continue. Check your code or restart sign-in.");
  assert.deepEqual(calls(wrong.state).slice(-2), [`POST /v1/auth/transactions/${TX}/email-otp/verify`, `POST /v1/auth/transactions/${TX}/complete`]);
  assert.equal(wrong.state.navigated, null);
  const proved = page({ replies: { [`POST /v1/auth/transactions/${TX}/email-otp/verify`]: { status: 409, json: { error: { code: "transaction_already_proved" } } }, [`POST /v1/auth/transactions/${TX}/complete`]: { status: 200, json: { redirectUrl: "/app" } } } });
  const again = signIn(proved.options);
  await again.sendCode("ana@example.com");
  assert.deepEqual(await again.verifyCode("111111"), { redirectUrl: "/app" });
  assert.equal(proved.state.navigated, "https://shop.example/app");
});

test("the inputs are checked before anything is sent", async () => {
  const { state, options } = page();
  const auth = signIn(options);
  await assert.rejects(() => auth.sendCode(""), TypeError);
  await assert.rejects(() => auth.verifyCode("  "), TypeError);
  assert.throws(() => signIn({ ...options, returnPath: "https://evil.example/" }), TypeError);
  assert.equal(state.log.length, 0);
});

test("session reads the session; signOut deletes it with the platform token and resolves on the 204", async () => {
  const { state, options } = page({ replies: { "GET /_mdrn/v1/auth/session": { status: 200, json: { state: "authenticated", user: { id: "user_1", email: "ana@example.com" }, expiresAt: "2026-10-13T00:00:00Z" } } } });
  const current = await session(options);
  assert.equal(current.state, "authenticated");
  assert.equal(current.user.email, "ana@example.com");
  assert.equal(await signOut(options), undefined);
  assert.deepEqual(calls(state), ["GET /_mdrn/v1/auth/session", "GET /_mdrn/v1/platform/csrf", "DELETE /_mdrn/v1/auth/session"]);
  assert.equal(state.log[2].csrf, "platform-csrf");
  assert.equal(state.log[2].body, undefined);
  const anonymous = page();
  assert.deepEqual(await session(anonymous.options), { state: "anonymous", user: null });
  const refused = page({ replies: { "DELETE /_mdrn/v1/auth/session": { status: 401, json: { error: { code: "invalid_session" } } } } });
  await assert.rejects(() => signOut(refused.options), (error) => error instanceof SignInError && error.code === "invalid_session" && error.status === 401);
});
