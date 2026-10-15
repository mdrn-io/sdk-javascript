// The MDRN SDK for JavaScript: one client for the products a release has (Database, Files,
// Mail) and for who is calling it (Auth). Web APIs only, so it runs in a Worker and in Node.js
// 20+. The wire contract is sdk/contracts/client.openapi.json; the names of the methods are
// sdk/contracts/operations.json, shared with the Python, Go and Rust SDKs.

/** A call that did not succeed. `status` is the HTTP status (0 when no response was received),
 * `code` MDRN's error code or one of the SDK's own (PRODUCT_NOT_ENABLED, UNEXPECTED_REDIRECT,
 * HTTP_ERROR, TIMEOUT, NETWORK_ERROR, UPLOAD_FAILED, FILE_REJECTED), `details` the response
 * body or the underlying error. The message is MDRN's and is for your logs. */
export class MdrnError extends Error {
  constructor(status, code, message, details) {
    super(message || (status ? `MDRN request failed with HTTP ${status}` : code));
    this.name = "MdrnError";
    this.status = status;
    this.code = code || "HTTP_ERROR";
    this.details = details;
  }
}

const ENVIRONMENTS = ["sandbox", "production"];
// The token is a bearer credential: it only travels over https, except to a development server
// on this machine (localhost, 127.0.0.1 or [::1]).
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PRODUCTS = {
  db: { variable: "DATABASE", label: "Database", path: "/_mdrn/v1/database" },
  files: { variable: "STORAGE", label: "Files", path: "/v1/storage" },
  mail: { variable: "MAIL", label: "Mail", path: "/v1/mail" },
};
const DEFAULT_PART_BYTES = 16 * 1024 * 1024;
const POLL_MS = 1000;
const WAIT_MS = 60_000;
const CONFLICT_RETRIES = 3;

function secureUrl(value, what) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${what} must be an https URL`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.includes(url.hostname))) {
    throw new TypeError(`${what} must be an https URL (http is allowed only for localhost, 127.0.0.1 or [::1])`);
  }
  return url.href.replace(/\/$/, "");
}

const segment = (value) => encodeURIComponent(String(value));
const records = (collection, id) => `/collections/${segment(collection)}/records${id === undefined ? "" : `/${segment(id)}`}`;
const page = (options = {}) => {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.cursor !== undefined && options.cursor !== null) query.set("cursor", String(options.cursor));
  return query.size ? `?${query}` : "";
};
// A write's options: its idempotency key (a fresh one unless given) and cancellation.
const write = (options = {}) => ({ idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(), signal: options.signal });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

// The version an update or delete was given, checked; undefined when none was.
function givenVersion(options) {
  const { version } = options;
  if (version === undefined) return undefined;
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError("version must be a positive integer");
  return version;
}

// A file to upload, checked: its name and its bytes as a Uint8Array.
function checkFile({ name, type, bytes } = {}) {
  if (typeof name !== "string" || !name) throw new TypeError("name is required");
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array or an ArrayBuffer");
  return { name, type, bytes };
}

export class Mdrn {
  #products;
  #fetcher;
  #transfer;
  #timeoutMs;

  /**
   * @param {object} options
   * @param {string} [options.origin] The release's origin (https://<your app>); each product's
   *   URL is derived from it. A token without it (and without that product's `urls` entry)
   *   enables nothing.
   * @param {string} options.project MDRN_PROJECT_ID.
   * @param {"sandbox"|"production"} options.environment MDRN_ENVIRONMENT.
   * @param {{database?: string, storage?: string, mail?: string}} [options.tokens] The product
   *   tokens; a product without one is not enabled.
   * @param {{database?: string, storage?: string, mail?: string}} [options.urls] Product URLs
   *   that replace the ones derived from `origin` (fromEnv passes MDRN_*_URL here).
   * @param {typeof fetch} [options.fetcher] Sends every product request; in a Worker the
   *   MDRN_PRODUCTS binding's fetch. Defaults to the global fetch.
   * @param {typeof fetch} [options.transfer] Sends bytes to and from grant URLs (the Files
   *   gateway). Always a plain fetch: never the binding, never with a product token.
   * @param {number} [options.timeoutMs] Per-request deadline, 10 s by default.
   */
  constructor({ origin, project, environment, tokens = {}, urls = {}, fetcher = globalThis.fetch, transfer = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    if (typeof project !== "string" || !project) throw new TypeError("project is required");
    if (!ENVIRONMENTS.includes(environment)) throw new TypeError("environment must be sandbox or production");
    if (typeof fetcher !== "function") throw new TypeError("fetcher must be a function");
    if (typeof transfer !== "function") throw new TypeError("transfer must be a function");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be a positive number");
    this.project = project;
    this.environment = environment;
    this.#fetcher = fetcher;
    this.#transfer = transfer;
    this.#timeoutMs = timeoutMs;
    const base = origin === undefined || origin === null || origin === "" ? undefined : secureUrl(origin, "origin");
    this.#products = {};
    for (const [name, product] of Object.entries(PRODUCTS)) {
      const key = product.variable.toLowerCase();
      const token = tokens[key] || undefined;
      let url = urls[key] || undefined;
      // A token without a URL (no origin, no urls entry) enables nothing: the product is
      // not enabled, and a call on it says which MDRN_*_URL is missing.
      if (url === undefined && token !== undefined && base !== undefined) url = base + product.path;
      if (url !== undefined) url = secureUrl(url, `MDRN_${product.variable}_URL`);
      const missing = token === undefined ? "TOKEN" : "URL";
      this.#products[name] = {
        url: url !== undefined && token !== undefined ? url : undefined,
        token,
        unavailable: `${product.label} is not enabled for this environment (MDRN_${product.variable}_${missing} is missing)`,
      };
    }
    this.enabled = Object.keys(PRODUCTS).filter((name) => this.#products[name].url !== undefined);
    const self = this;

    this.db = {
      create: (collection, data, options) => self.#call("db", records(collection), { method: "POST", body: { data }, ...write(options) }),
      get: (collection, id) => self.#read("db", records(collection, id)),
      list: (collection, options) => self.#call("db", records(collection) + page(options), { signal: options?.signal }),
      // The version is checked before #mutate runs, so a bad one is a synchronous TypeError.
      update: (collection, id, patch, options = {}) =>
        self.#mutate(collection, id, givenVersion(options), options, (version, key) =>
          self.#call("db", records(collection, id), { method: "PATCH", body: { data: patch }, ifMatch: version, idempotencyKey: key, signal: options.signal })),
      delete: (collection, id, options = {}) =>
        self.#mutate(collection, id, givenVersion(options), options, (version, key) =>
          self.#call("db", records(collection, id), { method: "DELETE", ifMatch: version, idempotencyKey: key, signal: options.signal })).then(() => undefined),
    };

    const uploads = {
      create: (input, options) => self.#call("files", "/uploads", { method: "POST", body: input, ...write(options) }),
      get: (uploadId) => self.#read("files", `/uploads/${segment(uploadId)}`),
      list: (options) => self.#call("files", "/uploads" + page(options), { signal: options?.signal }),
      parts: (uploadId, options) => self.#call("files", `/uploads/${segment(uploadId)}/parts` + page(options), { signal: options?.signal }),
      part: (uploadId, { partNumber, size }, options) =>
        self.#call("files", `/uploads/${segment(uploadId)}/parts`, { method: "POST", body: { partNumber, bytes: size }, ...write(options) }),
      complete: (uploadId, parts, options) =>
        self.#call("files", `/uploads/${segment(uploadId)}/complete`, { method: "POST", body: { parts }, ...write(options) }),
      abort: async (uploadId, options) => {
        await self.#call("files", `/uploads/${segment(uploadId)}`, { method: "DELETE", ...write(options) });
      },
    };
    this.files = {
      uploads,
      upload: (file, options) => self.#upload(checkFile(file), options),
      get: (id) => self.#read("files", `/objects/${segment(id)}`),
      list: (options) => self.#call("files", "/objects" + page(options), { signal: options?.signal }),
      downloadUrl: async (id, options) => {
        const grant = await self.#call("files", `/objects/${segment(id)}/download-grants`, { method: "POST", body: {}, ...write(options) });
        return { url: grant.url, expiresAt: grant.expiresAt };
      },
      delete: async (id, options) => {
        await self.#call("files", `/objects/${segment(id)}`, { method: "DELETE", ...write(options) });
      },
      operation: (id) => self.#call("files", `/operations/${segment(id)}`),
    };

    this.mail = {
      send: (message, options) => {
        const { to, subject, text, html, attachments, template, senderId, ...rest } = message ?? {};
        const unknown = Object.keys(rest);
        if (unknown.length) throw new TypeError(`Unknown mail field: ${unknown.join(", ")}`);
        if (typeof to !== "string" || !to) throw new TypeError("to is required");
        if (template !== undefined && (subject !== undefined || text !== undefined || html !== undefined)) {
          throw new TypeError("A template supplies subject, text and html; send either a template or your own content");
        }
        const body = { recipient: to };
        if (subject !== undefined) body.subject = subject;
        if (text !== undefined) body.text = text;
        if (html !== undefined) body.html = html;
        if (template !== undefined) body.templateId = template;
        if (attachments !== undefined) body.attachments = attachments;
        if (senderId !== undefined) body.senderId = senderId;
        return self.#call("mail", "/messages", { method: "POST", body, ...write(options) });
      },
    };

    this.auth = {
      // MDRN's Proxy deletes every x-mdrn-* header a client sent before adding these two for a
      // signed-in visitor, so they can be trusted on a request MDRN delivered.
      user: (request) => {
        const id = request.headers.get("x-mdrn-user-id");
        const token = request.headers.get("x-mdrn-identity-token");
        if (!id || !token || !USER_ID.test(id)) return null;
        return { id, token };
      },
      me: async (request) => {
        const user = self.auth.user(request);
        if (!user) return null;
        const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${user.token}`, "MDRN-Project": self.project, "MDRN-Environment": self.environment });
        return self.#send(self.#fetcher, new URL("/v1/auth/me", request.url).href, { method: "GET", headers }, undefined,
          (response) => (response.status === 401 || response.status === 404 ? null : self.#payload(response)));
      },
    };
  }

  /** The client of a deployed release, from what MDRN injected into `env`. Product requests go
   * through the MDRN_PRODUCTS service binding when there is one, else the global fetch. */
  static fromEnv(env, { fetcher, transfer, timeoutMs } = {}) {
    if (!env || typeof env !== "object") throw new TypeError("env is required");
    const binding = env.MDRN_PRODUCTS;
    const options = {
      project: env.MDRN_PROJECT_ID,
      environment: env.MDRN_ENVIRONMENT,
      tokens: { database: env.MDRN_DATABASE_TOKEN, storage: env.MDRN_STORAGE_TOKEN, mail: env.MDRN_MAIL_TOKEN },
      urls: { database: env.MDRN_DATABASE_URL, storage: env.MDRN_STORAGE_URL, mail: env.MDRN_MAIL_URL },
      fetcher: fetcher ?? (typeof binding?.fetch === "function" ? binding.fetch.bind(binding) : globalThis.fetch),
    };
    if (transfer !== undefined) options.transfer = transfer;
    if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
    return new Mdrn(options);
  }

  // One request to a product: its URL and token, the project and environment, and the write
  // headers when given. The answer is the JSON body, undefined for 204, or an MdrnError.
  async #call(name, path, { method = "GET", body, idempotencyKey, ifMatch, signal } = {}) {
    const product = this.#products[name];
    if (product.url === undefined) throw new MdrnError(0, "PRODUCT_NOT_ENABLED", product.unavailable);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${product.token}`,
      "MDRN-Project": this.project,
      "MDRN-Environment": this.environment,
    });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (ifMatch !== undefined) headers.set("If-Match", String(ifMatch));
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    return this.#send(this.#fetcher, product.url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, signal, (response) => this.#payload(response));
  }

  // The response body as JSON; an MdrnError for a failure, with the code of MDRN's error
  // envelope ({error: {code, message}} or {code, message}), or HTTP_ERROR when there is none.
  async #payload(response) {
    const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = payload?.error && typeof payload.error === "object" ? payload.error : payload;
      throw new MdrnError(response.status, typeof error?.code === "string" ? error.code : "HTTP_ERROR", typeof error?.message === "string" ? error.message : undefined, payload);
    }
    return payload;
  }

  // A fetch with the deadline, without following redirects (a 3xx is an error, so the bearer
  // token can never be carried to another origin), and with transport failures as MdrnErrors.
  // `read` consumes the response under the same deadline; the deadline's timer is cleared once
  // it has, so a finished request keeps no process alive. (AbortSignal.timeout would be shorter,
  // but its timer is unreferenced on Node: a process with nothing else pending exits before it
  // fires, and the request never settles.)
  async #send(fetcher, url, init, signal, read = (response) => response) {
    // A request cancelled before it is sent is not sent (and never handed to a fetcher that
    // would wait for an abort event that already happened).
    if (signal?.aborted) throw signal.reason;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    try {
      let response;
      try {
        // Workers accept only "follow" or "manual" for redirect.
        response = await fetcher(new Request(url, { ...init, redirect: "manual", signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal }));
      } catch (error) {
        if (signal?.aborted) throw error;
        if (deadline.signal.aborted) throw new MdrnError(0, "TIMEOUT", `MDRN did not answer within ${this.#timeoutMs} ms`, error);
        throw new MdrnError(0, "NETWORK_ERROR", `MDRN could not be reached: ${error?.message ?? error}`, error);
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new MdrnError(response.status, "UNEXPECTED_REDIRECT", `MDRN answered with a redirect (HTTP ${response.status}), which the SDK does not follow`, { location: response.headers.get("location") });
      }
      return await read(response);
    } finally {
      clearTimeout(timer);
    }
  }

  // A read that answers null when there is no such thing.
  async #read(name, path) {
    try {
      return await this.#call(name, path);
    } catch (error) {
      if (error instanceof MdrnError && error.status === 404) return null;
      throw error;
    }
  }

  // An update or delete. With a version: one request with that If-Match, never retried. Without:
  // the record is read and the write sent with the version read, and on a 409 (the record
  // changed in between) the pair is repeated up to CONFLICT_RETRIES more times. Each attempt is
  // its own change, so a retry gets a fresh idempotency key (MDRN refuses a key reused with
  // another If-Match); the caller's key, if any, is used for the first attempt.
  async #mutate(collection, id, version, options, attempt) {
    if (version !== undefined) return attempt(version, options.idempotencyKey ?? crypto.randomUUID());
    for (let retries = 0; ; retries += 1) {
      const current = await this.#call("db", records(collection, id), { signal: options.signal });
      try {
        return await attempt(current.version, retries === 0 && options.idempotencyKey !== undefined ? options.idempotencyKey : crypto.randomUUID());
      } catch (error) {
        if (!(error instanceof MdrnError && error.status === 409 && retries < CONFLICT_RETRIES)) throw error;
      }
    }
  }

  // The whole upload of a file: its SHA-256 up front, an upload session, one grant and one PUT
  // per part of `partBytes` (16 MiB; the session says), completion, and (unless wait is false)
  // the object once Files has verified it. Bytes go to the grant URL with the grant's own
  // headers through `transfer`, never through the binding and never with a product token.
  async #upload({ name, type, bytes }, options = {}) {
    const { signal, wait = true } = options;
    const key = options.idempotencyKey ?? crypto.randomUUID();
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
    const opened = await this.files.uploads.create({ filename: name, contentType: type || "application/octet-stream", bytes: bytes.byteLength, sha256 }, { idempotencyKey: key, signal });
    const upload = await this.#until(() => this.files.uploads.get(opened.id), (u) => u === null || u.state !== "pending");
    if (upload === null || upload.state !== "uploading") throw new MdrnError(0, "UPLOAD_FAILED", `The upload is ${upload?.state ?? "gone"}, not uploading`, upload);
    const partBytes = Number.isInteger(upload.partBytes) && upload.partBytes > 0 ? upload.partBytes : DEFAULT_PART_BYTES;
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < bytes.byteLength; offset += partBytes, partNumber += 1) {
      const chunk = bytes.subarray(offset, Math.min(offset + partBytes, bytes.byteLength));
      const grant = await this.files.uploads.part(upload.id, { partNumber, size: chunk.byteLength }, { idempotencyKey: `${key}-part-${partNumber}`, signal });
      const sent = await this.#send(this.#transfer, grant.url, { method: grant.method, headers: grant.headers, body: chunk }, signal,
        async (response) => ({ ok: response.ok, status: response.status, result: await response.json().catch(() => undefined) }));
      const { result } = sent;
      if (!sent.ok) throw new MdrnError(sent.status, "UPLOAD_FAILED", `Part ${partNumber} was not accepted (HTTP ${sent.status})`, result);
      parts.push({ partNumber, etag: result?.etag });
    }
    const completed = await this.files.uploads.complete(upload.id, parts, { idempotencyKey: `${key}-complete`, signal });
    const object = wait
      ? await this.#until(() => this.files.get(completed.id), (o) => o === null || o.state !== "verifying")
      : await this.files.get(completed.id);
    if (object === null) throw new MdrnError(0, "FILE_REJECTED", "The file is gone", null);
    if (object.state === "rejected") throw new MdrnError(0, "FILE_REJECTED", "Files rejected the upload: its bytes did not match the declared size or SHA-256", object);
    return object;
  }

  // Polls once a second, for at most a minute, until `done` holds for the answer.
  async #until(read, done) {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() >= deadline) throw new MdrnError(0, "TIMEOUT", `Gave up waiting after ${WAIT_MS / 1000} s`, value);
      await sleep(POLL_MS);
    }
  }
}

/** The schedule run a request carries, or null when it is not one. MDRN strips every x-mdrn-*
 * header from public requests, so only MDRN can send these. The run id is the same across
 * retries of one run; use it to make the work idempotent. */
export function scheduledRun(request) {
  const schedule = request.headers.get("x-mdrn-schedule"), runId = request.headers.get("x-mdrn-run-id");
  if (!schedule || !runId) return null;
  return { schedule, runId, scheduledTime: request.headers.get("x-mdrn-scheduled-time"), attempt: Number(request.headers.get("x-mdrn-attempt") ?? 1) };
}
