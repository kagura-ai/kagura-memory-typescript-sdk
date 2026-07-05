/**
 * REST client for Kagura Memory Cloud file uploads (port of files_client.py).
 *
 * Drives the 3-step file upload flow against memory-cloud:
 * 1. `POST /api/v1/files/reserve` — server returns a presigned PUT URL.
 * 2. `PUT` to R2 with body bytes and the `x-amz-checksum-sha256` header
 *    (base64 of the raw sha256 digest), when the presign signed it.
 * 3. `POST /api/v1/files/{file_id}/confirm` — finalize the row.
 *
 * Plus `downloadUrl()`, `delete()` and `list()`. The R2 PUT is sent with a
 * plain fetch and NO Authorization header so the SDK's Bearer credential
 * cannot leak to the object store — the presigned URL carries its own
 * short-lived SigV4 signature.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { SOURCE_LABEL, type AuthSource } from "./auth/types.js";
import {
  excMessage,
  KaguraConnectionError,
  KaguraError,
  KaguraIntegrityError,
} from "./errors.js";
import { extractDetail, sanitizeServerDetail, SDK_VERSION } from "./http.js";
import type {
  FileDownloadUrlResponse,
  FileListResponse,
  FileObject,
  FileReserveResponse,
} from "./models.js";
import {
  KaguraRestClient,
  type KaguraRestClientOptions,
  type RequestContext,
  type RestResponse,
} from "./restBase.js";
import { isUuid } from "./uuid.js";

/** A `KaguraConnectionError` carrying the raw non-2xx body for dedup inspection. */
interface ErrorWithResponse extends KaguraConnectionError {
  responseStatus?: number;
  responseText?: string;
}

export interface FilesClientOptions extends KaguraRestClientOptions {
  /** R2 PUT timeout in ms (default 300000 — 5 min for large files). */
  uploadTimeoutMs?: number;
}

export interface UploadOptions {
  /**
   * Target context (workspace) UUID. Mapped to the backend's
   * `workspace_id` field on the wire.
   */
  contextId: string;
  /**
   * File contents. A string is treated as a filesystem path (read fully
   * into memory); a `Uint8Array` is used directly.
   */
  source: string | Uint8Array;
  /** Required when `source` is bytes; defaults to the path basename otherwise. */
  filename?: string;
  /** MIME type; falls back to an extension guess then `application/octet-stream`. */
  contentType?: string;
  /**
   * Optional owning context to bind the file to for access control
   * (server v0.41.0+). Sent as the wire `context_id` field — distinct
   * from `contextId` above, which maps to `workspace_id`.
   */
  bindingContextId?: string;
}

/** Minimal extension→MIME map (Node has no `mimetypes` module). */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
};

export class FilesClient extends KaguraRestClient {
  private readonly uploadTimeoutMs: number;

  constructor(options: FilesClientOptions = {}) {
    super(options);
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? 300_000;
  }

  // -------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------

  /**
   * Upload a file to Kagura Memory Cloud, driving reserve → presigned PUT
   * → confirm. Returns the finalized {@link FileObject}.
   *
   * When the file already exists with the same sha256 in the workspace,
   * the server returns 409 and this surfaces the existing FileObject
   * (dedup happy-path) rather than throwing.
   *
   * @throws Error if `source` is bytes and `filename` is not provided.
   * @throws KaguraIntegrityError if R2 rejected the body sha256 binding.
   */
  async upload(options: UploadOptions): Promise<FileObject> {
    validateContextId(options.contextId);
    const { filename, body, sha256Hex, sha256Base64 } = await prepareSource(
      options.source,
      options.filename,
    );
    const sizeBytes = body.byteLength;
    const contentType = resolveContentType(options.contentType, filename);

    const reserveBody: Record<string, unknown> = {
      workspace_id: options.contextId,
      filename,
      content_type: contentType,
      size_bytes: sizeBytes,
      sha256: sha256Hex,
    };
    // Only send context_id when a binding was requested — omitting it keeps
    // the upload NULL-context (workspace-scoped, legacy behaviour).
    if (options.bindingContextId !== undefined) {
      reserveBody.context_id = options.bindingContextId;
    }

    let reserveResp: RestResponse;
    try {
      reserveResp = await this.request("POST", "/api/v1/files/reserve", { json: reserveBody });
    } catch (e) {
      // 409 dedup happy-path: the server reports the existing file in the
      // error body; surface it as a FileObject so callers need not special-
      // case duplicates.
      const existing = extractExistingFile(e);
      if (existing !== null) {
        return existing;
      }
      throw e;
    }

    const reserve = this.json(reserveResp) as FileReserveResponse;
    await this.putToObjectStore(reserve.upload_url, body, sha256Base64, contentType);

    // workspace_id is required on the confirm query string (memory-cloud
    // v0.41.0); omitting it returns 422 and the upload never finalizes.
    const confirmResp = await this.request("POST", `/api/v1/files/${reserve.file_id}/confirm`, {
      params: { workspace_id: options.contextId },
      json: { sha256: sha256Hex },
    });
    return this.json(confirmResp) as FileObject;
  }

  /** Return a short-lived presigned GET URL for `fileId`. */
  async downloadUrl(fileId: string, options: { contextId: string }): Promise<string> {
    validateContextId(options.contextId);
    const response = await this.request("GET", `/api/v1/files/${fileId}/download-url`, {
      params: { workspace_id: options.contextId },
    });
    return (this.json(response) as FileDownloadUrlResponse).download_url;
  }

  /** Soft-delete a file by id (server hard-deletes after retention). */
  async delete(fileId: string, options: { contextId: string }): Promise<void> {
    validateContextId(options.contextId);
    await this.request("DELETE", `/api/v1/files/${fileId}`, {
      params: { workspace_id: options.contextId },
    });
  }

  /** List uploaded files in a workspace, newest first. */
  async list(options: {
    contextId: string;
    /** Maximum files to return (1-500, default 50). */
    limit?: number;
    /** Forward-compatible pagination cursor (ignored by the current server). */
    cursor?: string;
  }): Promise<FileListResponse> {
    validateContextId(options.contextId);
    const params: Record<string, unknown> = {
      workspace_id: options.contextId,
      limit: options.limit ?? 50,
    };
    if (options.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    const response = await this.request("GET", "/api/v1/files", { params });
    const raw = this.json(response);
    // Current server returns a bare `list[FileObject]`; future versions may
    // return `{files, next_cursor}`.
    if (Array.isArray(raw)) {
      return { files: raw as FileObject[], next_cursor: null };
    }
    return raw as FileListResponse;
  }

  // -------------------------------------------------------------------
  // R2 PUT (unauthenticated by design)
  // -------------------------------------------------------------------

  /**
   * PUT `body` to the presigned R2 URL with checksum binding. Sends
   * `x-amz-checksum-sha256` (base64 of the raw digest) only when the
   * presign signed it; a 400 from the store → {@link KaguraIntegrityError}.
   */
  private async putToObjectStore(
    uploadUrl: string,
    body: Uint8Array,
    sha256Base64: string,
    contentType: string,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "content-type": contentType,
      "user-agent": `kagura-memory-sdk/${SDK_VERSION}`,
    };
    // Send the checksum header ONLY when the presign signed it: a server with
    // R2 checksum binding OFF presigns without it, and sending it anyway makes
    // the SigV4 signature mismatch → 403 SignatureDoesNotMatch (#226).
    if (presignSignsChecksum(uploadUrl)) {
      headers["x-amz-checksum-sha256"] = sha256Base64;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      });
    } catch (e) {
      throw new KaguraConnectionError(`Object store PUT failed: ${excMessage(e)}`, { cause: e });
    }
    if (response.status === 400) {
      throw new KaguraIntegrityError(
        "Object store rejected upload with HTTP 400 — most commonly R2 " +
          "BadDigest (body sha256 did not match the presigned PUT binding). " +
          "Verify that the SDK is computing sha256 over the exact bytes being PUT.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new KaguraConnectionError(`Object store PUT failed: HTTP ${response.status}`);
    }
  }

  // -------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------

  /**
   * 403 → a workspace-mismatch hint (issue #115): surface the credential
   * source and requested workspace prefix without leaking the api_key.
   */
  protected override error403(response: RestResponse, context: RequestContext): KaguraError {
    return new KaguraConnectionError(
      formatWorkspace403Hint({
        authSource: this.authSource,
        sourceWorkspaceHint: this.workspaceIdHint,
        requestedWorkspace: extractRequestedWorkspace(context.requestJson, context.requestParams),
        serverDetail: extractDetail(response.text),
      }),
    );
  }

  /** Stash the raw non-2xx body so the 409 dedup path can recover `existing_file`. */
  protected override genericError(response: RestResponse): KaguraError {
    const err = super.genericError(response) as ErrorWithResponse;
    err.responseStatus = response.status;
    err.responseText = response.text;
    return err;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Truncate a UUID to its 8-char prefix for log-friendly display. */
function shortWorkspace(uuidStr: string | null): string {
  if (!uuidStr) {
    return "<none>";
  }
  return `${uuidStr.slice(0, 8)}…`;
}

/** Recover the `workspace_id` the failing request was targeting. */
function extractRequestedWorkspace(
  json: Record<string, unknown> | undefined,
  params: Record<string, unknown> | undefined,
): string | null {
  if (json !== undefined) {
    const ws = json.workspace_id;
    if (typeof ws === "string") {
      return ws;
    }
  }
  if (params !== undefined) {
    const ws = params.workspace_id;
    if (typeof ws === "string") {
      return ws;
    }
  }
  return null;
}

/** Compose the actionable 403 message for issue #115. */
function formatWorkspace403Hint(args: {
  authSource: AuthSource | null;
  sourceWorkspaceHint: string | null;
  requestedWorkspace: string | null;
  serverDetail: string | null;
}): string {
  const { authSource, sourceWorkspaceHint, requestedWorkspace, serverDetail } = args;
  if (authSource === null) {
    const safeDetail = sanitizeServerDetail(serverDetail);
    return safeDetail ? `HTTP 403: ${safeDetail}` : "HTTP 403";
  }
  const sourceLabel = SOURCE_LABEL[authSource] ?? String(authSource);
  const heading = requestedWorkspace
    ? "HTTP 403 — workspace not accessible with current credentials."
    : "HTTP 403 — access denied with current credentials.";
  const lines = [
    heading,
    `  api_key source: ${sourceLabel} (workspace=${shortWorkspace(sourceWorkspaceHint)})`,
  ];
  if (requestedWorkspace) {
    lines.push(`  workspace requested: ${shortWorkspace(requestedWorkspace)}`);
    lines.push("  Hint: contextId may not match the workspace bound to your api_key.");
  }
  const safeDetail = sanitizeServerDetail(serverDetail);
  if (safeDetail) {
    lines.push(`  server detail: ${safeDetail}`);
  }
  return lines.join("\n");
}

/** Pull an `existing_file` payload out of a 409 dedup response. */
function extractExistingFile(error: unknown): FileObject | null {
  if (!(error instanceof KaguraConnectionError)) {
    return null;
  }
  const withResponse = error as ErrorWithResponse;
  if (withResponse.responseStatus !== 409 || withResponse.responseText === undefined) {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(withResponse.responseText);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const existing = (body as Record<string, unknown>).existing_file;
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    return null;
  }
  return existing as FileObject;
}

/** Fail fast on a non-UUID `contextId`. */
function validateContextId(contextId: string): void {
  if (!isUuid(contextId)) {
    throw new Error(
      `contextId must be a UUID; got ${JSON.stringify(contextId)}. ` +
        "Use the OAuth profile's workspace_id, a UUID from `kagura context list`, " +
        "or run `kagura auth login` first.",
    );
  }
}

/** True if the presigned URL signed the sha256 checksum header. */
function presignSignsChecksum(uploadUrl: string): boolean {
  let signed = "";
  try {
    signed = new URL(uploadUrl).searchParams.get("X-Amz-SignedHeaders") ?? "";
  } catch {
    return false;
  }
  return signed.toLowerCase().includes("x-amz-checksum-sha256");
}

/** Pick a content type — explicit > extension guess > octet-stream. */
function resolveContentType(contentType: string | undefined, filename: string): string {
  if (contentType) {
    return contentType;
  }
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

/** Resolve filename, load bytes, compute sha256 (hex + base64 of raw digest). */
async function prepareSource(
  source: string | Uint8Array,
  filename: string | undefined,
): Promise<{ filename: string; body: Uint8Array; sha256Hex: string; sha256Base64: string }> {
  let body: Uint8Array;
  let resolvedFilename: string;
  if (typeof source === "string") {
    body = await readFile(source);
    resolvedFilename = filename ?? path.basename(source);
  } else {
    if (!filename) {
      throw new Error(
        "filename is required when source is bytes (the server requires a non-empty filename).",
      );
    }
    body = source;
    resolvedFilename = filename;
  }
  const digest = createHash("sha256").update(body).digest();
  return {
    filename: resolvedFilename,
    body,
    sha256Hex: digest.toString("hex"),
    sha256Base64: digest.toString("base64"),
  };
}
