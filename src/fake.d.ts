import type { MdrnEnv, Record } from "./index.js";

export interface FakeOptions {
  /** The origin the product URLs are under; https://app.example by default. */
  origin?: string;
  /** Where grant URLs point; the origin by default. */
  filesOrigin?: string;
  project?: string;
  environment?: string;
  /** The size of an upload part, 16 MiB by default; small in tests to get several parts. */
  partBytes?: number;
  tokens?: { database?: string; storage?: string; mail?: string };
}

export interface LogEntry {
  method: string;
  /** Path and query. */
  path: string;
  /** authorization, mdrn-project, mdrn-environment, idempotency-key, if-match, content-type
   * and x-mdrn-grant, when sent. */
  headers: { [name: string]: string };
  /** The JSON body of a mutation; `{bytes}` for a part PUT; null otherwise. */
  body: unknown;
  status: number;
}

export interface SentMessage {
  id: string;
  recipient: string;
  subject: string;
  text: string;
  html: string | null;
  attachments: { filename: string; type: string; content: string }[];
  senderId: string | null;
  templateId: string | null;
}

export interface FakeMdrn {
  /** What MDRN injects into a release, with MDRN_PRODUCTS answered by this fake. */
  env: MdrnEnv & { MDRN_PRODUCTS: { fetch: typeof fetch } };
  /** Serves a product request, a grant URL or /v1/auth/me. */
  fetch: typeof fetch;
  collections: Map<string, Map<string, Record>>;
  uploads: Map<string, unknown>;
  objects: Map<string, unknown>;
  operations: Map<string, unknown>;
  /** Mail templates by id; `welcome` exists. */
  templates: Map<string, { subject: string; text: string; html: string | null }>;
  /** Every message queued, in order. */
  sent: SentMessage[];
  /** Every request served, in order. */
  log: LogEntry[];
  /** Makes `id` a signed-in user and gives the two headers MDRN's Proxy adds to their requests. */
  signIn(id: string, email?: string, token?: string): { "x-mdrn-user-id": string; "x-mdrn-identity-token": string };
  /** Sends bytes to a part grant's URL as a browser would. */
  putBytes(grantUrl: string, bytes: Uint8Array | ArrayBuffer): Promise<{ partNumber: number; bytes: number; etag: string }>;
  /** Fetches a download grant's URL. */
  getBytes(grantUrl: string): Promise<Uint8Array>;
  /** Forgets every record, upload, object, message, replay and log entry. */
  reset(): void;
}

export function createFakeMdrn(options?: FakeOptions): FakeMdrn;
