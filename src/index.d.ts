/** A call that did not succeed. `status` is the HTTP status, 0 when no response was received.
 * `code` is MDRN's error code, or one of the SDK's own: PRODUCT_NOT_ENABLED, UNEXPECTED_REDIRECT,
 * HTTP_ERROR, TIMEOUT, NETWORK_ERROR, UPLOAD_FAILED, FILE_REJECTED. */
export class MdrnError extends Error {
  constructor(status: number, code: string, message?: string, details?: unknown);
  status: number;
  code: string;
  details: unknown;
}

export type Environment = "sandbox" | "production";
export type Product = "db" | "files" | "mail";

/** The options of a write: its idempotency key (a fresh UUID unless given; the same key sends
 * the same change once) and a signal to cancel it. */
export interface Write {
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ListOptions {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Record<T = { [key: string]: unknown }> {
  id: string;
  collection: string;
  version: number;
  data: T;
  createdAt: string;
  updatedAt: string;
}

export interface Database {
  /** Creates a record with `data` (a JSON object) and answers it with its id and version 1. */
  create<T extends object = { [key: string]: unknown }>(collection: string, data: T, options?: Write): Promise<Record<T>>;
  /** The record, or null when there is none with that id. */
  get<T = { [key: string]: unknown }>(collection: string, id: string): Promise<Record<T> | null>;
  list<T = { [key: string]: unknown }>(collection: string, options?: ListOptions): Promise<Page<Record<T>>>;
  /** Merges `patch` into the record's fields (a shallow merge). With `version`, the change is
   * sent once with that If-Match and a 409 CONFLICT is yours; without, the record is read first
   * and a conflict is retried up to three times. */
  update<T = { [key: string]: unknown }>(collection: string, id: string, patch: Partial<T> & object, options?: Write & { version?: number }): Promise<Record<T>>;
  delete(collection: string, id: string, options?: Write & { version?: number }): Promise<void>;
}

export type FileState = "verifying" | "ready" | "rejected" | "deleted" | "purging" | "purge_failed" | "purged" | "lost";

export interface FileInfo {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
  sha256: string;
  state: FileState;
  createdAt: string;
  deletedAt: string | null;
  purgeAt: string | null;
}

export type UploadState = "pending" | "uploading" | "verifying" | "complete" | "aborted" | "expired" | "rejected";

export interface Upload {
  id: string;
  objectId: string;
  state: UploadState;
  expiresAt: string;
  operationId: string | null;
  partBytes: number;
}

export interface UploadInput {
  filename: string;
  contentType: string;
  bytes: number;
  /** Hex SHA-256 of the whole file. */
  sha256: string;
}

export interface Grant {
  id: string;
  url: string;
  method: "GET" | "PUT";
  headers: { [name: string]: string };
  expiresAt: string;
  maxBytes: number;
}

export interface Part {
  partNumber: number;
  bytes: number;
  etag: string | null;
  state: string;
}

export interface Completion {
  id: string;
  filename: string;
  contentType: string;
  bytes: number;
  state: "verifying";
  operationId: string;
}

export interface Operation {
  id: string;
  kind: string;
  state: string;
  processedBytes: number;
  processedItems: number;
  attempts: number;
  retryAt: string | null;
  error: string | null;
}

/** The upload session as the wire has it: for resuming, or for sending bytes from somewhere
 * other than this process (a browser PUTs to the grant URL with the grant's headers). */
export interface Uploads {
  create(input: UploadInput, options?: Write): Promise<Upload>;
  get(uploadId: string): Promise<Upload | null>;
  list(options?: ListOptions): Promise<Page<Upload>>;
  parts(uploadId: string, options?: ListOptions): Promise<Page<Part>>;
  /** A grant to PUT one part of `size` bytes: 16 MiB (the session's partBytes) each but the last. */
  part(uploadId: string, part: { partNumber: number; size: number }, options?: Write): Promise<Grant>;
  complete(uploadId: string, parts: { partNumber: number; etag: string }[], options?: Write): Promise<Completion>;
  abort(uploadId: string, options?: Write): Promise<void>;
}

export interface Files {
  /** The whole upload: SHA-256, session, parts, completion and, unless `wait` is false, the
   * verified file (polled for up to a minute). Rejected bytes throw FILE_REJECTED. */
  upload(file: { name: string; type?: string; bytes: Uint8Array | ArrayBuffer }, options?: Write & { wait?: boolean }): Promise<FileInfo>;
  /** The file, or null when there is none with that id. */
  get(id: string): Promise<FileInfo | null>;
  list(options?: ListOptions): Promise<Page<FileInfo>>;
  /** A URL anyone can GET for 15 minutes. */
  downloadUrl(id: string, options?: Write): Promise<{ url: string; expiresAt: string }>;
  delete(id: string, options?: Write): Promise<void>;
  operation(id: string): Promise<Operation>;
  uploads: Uploads;
}

export interface Attachment {
  filename: string;
  type: "application/pdf" | "image/png" | "image/jpeg" | "text/plain";
  /** The file, base64 encoded. */
  content: string;
}

export interface Message {
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: Attachment[];
  /** A template of the project and environment, which supplies subject, text and html; it
   * cannot be combined with them (a TypeError, before any request). */
  template?: string;
  /** A verified sender domain of the workspace; omit it when there is exactly one. */
  senderId?: string;
}

export interface QueuedMessage {
  id: string;
  state: "queued";
  requestId?: string;
}

export interface Mail {
  send(message: Message, options?: Write): Promise<QueuedMessage>;
}

export interface User {
  id: string;
  /** The short-lived identity token of the session, for auth.me. */
  token: string;
}

export interface Profile {
  id: string;
  email?: string;
  name?: string;
  user_metadata?: { [key: string]: unknown };
  app_metadata?: { [key: string]: unknown };
  metadataState: "available" | "not_configured" | "disabled" | "unavailable";
}

export interface Auth {
  /** The signed-in visitor of a request MDRN delivered (from the x-mdrn-user-id and
   * x-mdrn-identity-token headers only MDRN can set), or null. */
  user(request: Request): User | null;
  /** The visitor's profile from MDRN Identity, or null when nobody is signed in or the session
   * has ended. */
  me(request: Request): Promise<Profile | null>;
}

export interface MdrnEnv {
  MDRN_PROJECT_ID: string;
  MDRN_ENVIRONMENT: Environment | string;
  MDRN_DATABASE_URL?: string;
  MDRN_DATABASE_TOKEN?: string;
  MDRN_STORAGE_URL?: string;
  MDRN_STORAGE_TOKEN?: string;
  MDRN_MAIL_URL?: string;
  MDRN_MAIL_TOKEN?: string;
  MDRN_PRODUCTS?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  [other: string]: unknown;
}

export interface MdrnOptions {
  /** The release's origin (https://<your app>); each product's URL is derived from it. */
  origin?: string;
  project: string;
  environment: Environment;
  /** The product tokens; a product without one is not enabled. */
  tokens?: { database?: string; storage?: string; mail?: string };
  /** Product URLs in place of the ones derived from `origin` (fromEnv passes MDRN_*_URL). */
  urls?: { database?: string; storage?: string; mail?: string };
  /** Sends every product request (in a Worker, the MDRN_PRODUCTS binding's fetch). */
  fetcher?: typeof fetch;
  /** Sends bytes to and from grant URLs: always a plain fetch, never the binding. */
  transfer?: typeof fetch;
  /** Per-request deadline in milliseconds, 10 000 by default. */
  timeoutMs?: number;
}

export class Mdrn {
  constructor(options: MdrnOptions);
  /** The client of a deployed release, from what MDRN injected into `env`. Product requests go
   * through the MDRN_PRODUCTS service binding when there is one, else the global fetch. */
  static fromEnv(env: MdrnEnv, options?: { fetcher?: typeof fetch; transfer?: typeof fetch; timeoutMs?: number }): Mdrn;
  readonly project: string;
  readonly environment: Environment;
  /** The products this client can call; a call on any other throws PRODUCT_NOT_ENABLED. */
  readonly enabled: Product[];
  readonly db: Database;
  readonly files: Files;
  readonly mail: Mail;
  readonly auth: Auth;
}

export interface ScheduledRun {
  schedule: string;
  runId: string;
  scheduledTime: string | null;
  attempt: number;
}

/** The schedule run a request carries, or null when it is not one. */
export function scheduledRun(request: Request): ScheduledRun | null;
