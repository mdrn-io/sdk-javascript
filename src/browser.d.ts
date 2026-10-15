/** Sign-in from the browser, for an app that serves its own sign-in page (`loginPage` set to
 * `own`): the calls MDRN's hosted page makes, on the app's own address, with the browser's
 * cookies. No dependencies and nothing from `@mdrnio/sdk`; it runs in any browser. */

/** A sign-in call that did not succeed. `code` is MDRN's error code (ACCOUNT_DISABLED,
 * RATE_LIMITED, EMAIL_UNDELIVERABLE, EMAIL_PAUSED, invalid_session, …), HTTP_ERROR for an answer
 * without one, NETWORK_ERROR when nothing answered, INVALID_DESTINATION for a redirect off this
 * origin; `status` the HTTP status, 0 for none. The message is a sentence to show the visitor. */
export class SignInError extends Error {
  constructor(status: number, code: string, message: string);
  status: number;
  code: string;
}

export type Provider = "google" | "github";

/** Why MDRN sent the visitor back to the page. `provider_cancelled` and `unavailable` keep the
 * sign-in, which the next call resumes; the others drop it, so the next call starts afresh. */
export type SignInReason = "provider_cancelled" | "unavailable" | "provider_attempts_exhausted" | "transaction_expired" | "transaction_already_proved" | "account_disabled";

/** The browser's own fetch, location and history unless given (a test gives its own). */
export interface BrowserOptions {
  fetch?: typeof fetch;
  location?: Pick<Location, "href" | "origin" | "assign">;
  history?: Pick<History, "replaceState">;
}

export interface SignInOptions extends BrowserOptions {
  /** Where the visitor goes once signed in; "/" unless given. */
  returnPath?: string;
}

export interface SignIn {
  /** The reason the address carried, or null. */
  readonly reason: SignInReason | null;
  /** A sentence to show for `reason`, or null. */
  readonly message: string | null;
  /** Starts a sign-in unless one is being resumed, and emails `email` a six-digit code. */
  sendCode(email: string): Promise<void>;
  /** Emails a new code to the address `sendCode` was given; MDRN allows one a minute. */
  resendCode(): Promise<void>;
  /** Verifies the code and finishes the sign-in: the browser goes to `redirectUrl`, unless
   * `navigate` is false; the answer is returned either way. */
  verifyCode(code: string, options?: { navigate?: boolean }): Promise<{ redirectUrl: string }>;
  /** Starts a sign-in unless one is being resumed, then sends the browser to the provider; the
   * visitor comes back signed in at `returnPath`, or to this page with a `reason`. */
  continueWith(provider: Provider): Promise<void>;
}

/** The sign-in of the page this is called on: it reads `?transactionId=` (a sign-in to resume)
 * and `?reason=` (why the visitor is back) from the address and removes them from it. One per
 * page load. */
export function signIn(options?: SignInOptions): SignIn;

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
}

export interface Session {
  state: "authenticated" | "anonymous";
  user: SessionUser | null;
  expiresAt?: string | null;
}

/** Whether the browser is signed in on this address (`GET /_mdrn/v1/auth/session`). */
export function session(options?: BrowserOptions): Promise<Session>;

/** Ends the browser's session on this address (`DELETE /_mdrn/v1/auth/session`, with the CSRF
 * token); resolves once it has. */
export function signOut(options?: BrowserOptions): Promise<void>;
