// Sign-in from the browser, for an app that serves its own sign-in page (loginPage set to own):
// the calls MDRN's hosted page makes (identity/web/login.js), on the app's own address, with the
// browser's cookies. Nothing from index.js, no dependencies: fetch, URL, location and history,
// each injectable for a test.

/** A sign-in call that did not succeed. `code` is MDRN's error code (ACCOUNT_DISABLED,
 * RATE_LIMITED, EMAIL_UNDELIVERABLE, EMAIL_PAUSED, invalid_session, …), HTTP_ERROR for an answer
 * without one, NETWORK_ERROR when nothing answered; `status` the HTTP status (0 for none). The
 * message is a sentence for the visitor. */
export class SignInError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "SignInError";
    this.status = status;
    this.code = code;
  }
}

const PLATFORM_CSRF = "/_mdrn/v1/platform/csrf";
const START = "/_mdrn/v1/auth/start";
const SESSION = "/_mdrn/v1/auth/session";
const PROVIDERS = ["google", "github"];
const TRANSACTION = /^[a-f0-9]{64}$/;
// Why MDRN sent the browser back here. A declined provider page, or one MDRN could not serve just
// then, keeps its sign-in; a used-up, expired or finished one is dropped, so the next step starts
// a new one. A Map, so a reason named like an Object property (constructor) is no reason at all.
const REASONS = new Map([
  ["provider_cancelled", "Sign-in was cancelled. Choose a way to sign in."],
  ["unavailable", "Sign-in is unavailable right now. Try again in a moment."],
  ["provider_attempts_exhausted", "That sign-in was tried too many times. Choose a way to sign in to start again."],
  ["transaction_expired", "That sign-in expired. Choose a way to sign in to start again."],
  ["transaction_already_proved", "That sign-in already finished in another tab or window. Choose a way to sign in to start again."],
  ["account_disabled", "Account disabled"],
]);
const KEPT = new Set(["provider_cancelled", "unavailable"]);
const WORDING = new Map([
  ["ACCOUNT_DISABLED", "Account disabled"],
  ["RATE_LIMITED", "Please wait before trying again."],
  ["EMAIL_UNDELIVERABLE", "That address cannot receive email. Check it and try again."],
  ["EMAIL_PAUSED", "This app cannot send sign-in emails right now. Try another way to sign in, or contact the app."],
]);
const FALLBACK = "Unable to continue. Check your code or restart sign-in.";
const OFFLINE = "Could not reach the app. Check your connection and try again.";

// The browser's own fetch, location and history unless a test injects its own.
function browser(options = {}) {
  const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetcher !== "function") throw new TypeError("fetch is required");
  return { fetch: fetcher, location: options.location ?? globalThis.location, history: options.history ?? globalThis.history };
}

// One call on the app's own address: a GET, or `method` with a JSON body and the CSRF token.
// The pre-sign-in cookie can be stale, so a 401 on the platform token is read once more, as
// the hosted page does. A failure is a SignInError with MDRN's code and the visitor's sentence.
async function request(env, path, { method = "GET", body, csrf } = {}) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") init.headers["X-CSRF-Token"] = csrf;
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  let response;
  try {
    response = await env.fetch(path, init);
    if (path === PLATFORM_CSRF && response.status === 401) response = await env.fetch(path, { credentials: "same-origin" });
  } catch {
    throw new SignInError(0, "NETWORK_ERROR", OFFLINE);
  }
  let value = null;
  const text = await response.text();
  if (text) { try { value = JSON.parse(text); } catch { value = null; } }
  if (!response.ok) {
    const code = typeof value?.error?.code === "string" ? value.error.code : "HTTP_ERROR";
    throw new SignInError(response.status, code, WORDING.get(code) ?? FALLBACK);
  }
  return value;
}

const text = (value, what) => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${what} is required`);
  return value.trim();
};

class SignIn {
  #env;
  #returnPath;
  #transaction;
  #csrf;
  #email;
  reason;
  message;

  constructor(options) {
    this.#env = browser(options);
    this.#returnPath = options.returnPath ?? "/";
    if (typeof this.#returnPath !== "string" || !this.#returnPath.startsWith("/")) throw new TypeError("returnPath must be a path starting with /");
    const { location, history } = this.#env;
    if (!location?.href) throw new TypeError("signIn runs in a browser, on the page MDRN sends visitors to");
    const opened = new URL(location.href);
    const reason = opened.searchParams.get("reason");
    const given = opened.searchParams.get("transactionId");
    this.reason = reason !== null && REASONS.has(reason) ? reason : null;
    this.message = this.reason ? REASONS.get(this.reason) : null;
    // An unknown reason drops the sign-in too: only a kept one is worth resuming.
    this.#transaction = (reason === null || KEPT.has(reason)) && given !== null && TRANSACTION.test(given) ? given : null;
    this.#csrf = null;
    this.#email = null;
    if ((reason !== null || given !== null) && history?.replaceState) {
      opened.searchParams.delete("reason");
      opened.searchParams.delete("transactionId");
      history.replaceState(null, "", opened.href);
    }
  }

  // The sign-in to prove, started unless one is being resumed, and its own CSRF token.
  async #ready(method) {
    if (!this.#transaction) {
      const { csrfToken } = await request(this.#env, PLATFORM_CSRF);
      const started = await request(this.#env, START, { method: "POST", body: { returnPath: this.#returnPath, method }, csrf: csrfToken });
      this.#transaction = started.transactionId;
      this.#csrf = null;
    }
    if (!this.#csrf) this.#csrf = (await request(this.#env, `/v1/auth/transactions/${this.#transaction}/csrf`)).csrfToken;
  }

  #post(action, body) {
    return request(this.#env, `/v1/auth/transactions/${this.#transaction}/${action}`, { method: "POST", body, csrf: this.#csrf });
  }

  #go(url) {
    const target = new URL(url, this.#env.location.origin);
    if (target.origin !== this.#env.location.origin) throw new SignInError(0, "INVALID_DESTINATION", "Invalid sign-in destination.");
    this.#env.location.assign(target.href);
  }

  /** Starts a sign-in unless one is being resumed, and emails `email` a six-digit code. */
  async sendCode(email) {
    const address = text(email, "email");
    await this.#ready("email_otp");
    await this.#post("email-otp/send", { email: address });
    this.#email = address;
  }

  /** Emails a new code to the address sendCode was given; MDRN allows one a minute. */
  async resendCode() {
    if (!this.#email) throw new TypeError("sendCode first");
    await this.sendCode(this.#email);
  }

  /** Verifies the code and finishes the sign-in: the browser goes to the answer's redirectUrl,
   * unless `navigate` is false; the answer is returned either way. A code already verified (a
   * second submit, say) is finished through `complete`, as the hosted page does. */
  async verifyCode(code, { navigate = true } = {}) {
    const digits = text(code, "code");
    await this.#ready("email_otp");
    let result;
    try {
      result = await this.#post("email-otp/verify", { code: digits });
    } catch (error) {
      try { result = await this.#post("complete", {}); } catch { throw error; }
    }
    if (navigate) this.#go(result.redirectUrl);
    return { redirectUrl: result.redirectUrl };
  }

  /** Starts a sign-in unless one is being resumed, then sends the browser to Google or GitHub;
   * the visitor comes back signed in at returnPath, or here with a reason. */
  async continueWith(provider) {
    if (!PROVIDERS.includes(provider)) throw new TypeError(`provider must be one of ${PROVIDERS.join(", ")}`);
    await this.#ready(provider);
    this.#go(`/v1/auth/transactions/${this.#transaction}/${provider}`);
  }
}

/** The sign-in of the page this is called on: it reads `?transactionId=` (a sign-in to resume)
 * and `?reason=` (why the visitor is back; `reason` and `message` say) from the address and
 * removes them from it. One per page load. */
export function signIn(options = {}) {
  return new SignIn(options);
}

/** Whether the browser is signed in on this address: `state` authenticated with `user` and
 * `expiresAt`, or anonymous. */
export function session(options) {
  return request(browser(options), SESSION);
}

/** Ends the browser's session on this address; resolves once it has. */
export async function signOut(options) {
  const env = browser(options);
  const { csrfToken } = await request(env, PLATFORM_CSRF);
  await request(env, SESSION, { method: "DELETE", csrf: csrfToken });
}
