/**
 * memory-cloud v0.156.0 – v0.161.0, as this SDK reads them (#147 – #149).
 *
 * Every reply below is shaped as the server at tag `v0.161.0` sends it.
 *
 * Upload malware scanning (v0.160.0+, memory-cloud#565; #147): every file
 * object carries `scan_status` (`FileObjectOut` in
 * `backend/src/api/routes/files.py`), and `GET /api/v1/files/{id}/download-url`
 * refuses a file the scan holds with `FileScanPendingError` (409 `SCAN-001`,
 * `Retry-After: 30`, `details {file_id, scan_status: "pending"}`) or
 * `FileBlockedError` (409 `SCAN-002`, `details {file_id, scan_status}`), from
 * `backend/src/utils/exceptions.py`, as `memory_cloud_exception_handler`
 * renders them (`{error, message, details}` plus the exception's
 * `response_headers`).
 */

import { describe, expect, it } from "vitest";

import {
  KaguraConnectionError,
  KaguraError,
  KaguraFileBlockedError,
  KaguraFileScanPendingError,
  KaguraNotFoundError,
  KaguraVersionConflictError,
} from "../src/errors.js";
import { FilesClient } from "../src/filesClient.js";
import * as sdk from "../src/index.js";
import type { FileObject } from "../src/models.js";
import { FILE_OBJECT, readModel } from "../src/pyModels.js";
import { FakeRest } from "./fakeServer.js";

const WS = "00000000-0000-4000-8000-000000000001";
const FILE_ID = "10000000-0000-4000-8000-000000000002";
const PENDING_MESSAGE = "This file is still being checked for malware. Try again shortly.";
const BLOCKED_MESSAGE = "This file cannot be downloaded: the malware scan blocked it.";

function fileRow(scanStatus?: string): Record<string, unknown> {
  return {
    id: FILE_ID,
    workspace_id: WS,
    context_id: null,
    filename: "hello.txt",
    content_type: "text/plain",
    size_bytes: 18,
    sha256: "0".repeat(64),
    status: "uploaded",
    ...(scanStatus === undefined ? {} : { scan_status: scanStatus }),
    created_at: "2026-11-14T00:00:00Z",
    uploaded_at: "2026-11-14T00:00:01Z",
  };
}

function rest(status: number, body: unknown, headers: Record<string, string> = {}): FakeRest {
  const fake = new FakeRest();
  fake.status = status;
  fake.body = JSON.stringify(body);
  fake.responseHeaders = headers;
  return fake;
}

function filesClient(fake: FakeRest): FilesClient {
  return new FilesClient({ apiKey: "kagura_test", baseUrl: "https://x.test", fetch: fake.fetch });
}

async function downloadError(fake: FakeRest): Promise<unknown> {
  return filesClient(fake)
    .downloadUrl(FILE_ID, { contextId: WS })
    .then(
      () => {
        throw new Error("downloadUrl did not throw");
      },
      (e: unknown) => e,
    );
}

const pending = (headers: Record<string, string> = { "Retry-After": "30" }): FakeRest =>
  rest(409, { error: "SCAN-001", message: PENDING_MESSAGE, details: { file_id: FILE_ID, scan_status: "pending" } }, headers);

const blocked = (scanStatus: string): FakeRest =>
  rest(409, { error: "SCAN-002", message: BLOCKED_MESSAGE, details: { file_id: FILE_ID, scan_status: scanStatus } });

describe("FileObject.scan_status (memory-cloud v0.160.0+, #147)", () => {
  it("is read as a plain string, so a value a newer server adds still reads", () => {
    for (const value of ["unscanned", "pending", "clean", "infected", "error", "quarantined"]) {
      expect(readModel(fileRow(value), FILE_OBJECT, "FilesClient.list").scan_status).toBe(value);
    }
  });

  it("is left out of the read for a server before v0.160.0, which never sends it", () => {
    const read = readModel(fileRow(), FILE_OBJECT, "FilesClient.list");
    expect(read).not.toHaveProperty("scan_status");
  });

  it("is refused when it is no string, as the model refuses any field of the wrong type", () => {
    expect(() => readModel({ ...fileRow(), scan_status: 5 }, FILE_OBJECT, "FilesClient.list")).toThrow(
      "scan_status: Input should be a valid string",
    );
  });

  it("comes back typed from list (absent on a row that has none)", async () => {
    const listed = await filesClient(rest(200, [fileRow("clean"), fileRow("unscanned"), fileRow()])).list({ contextId: WS });
    const states: Array<string | null | undefined> = listed.files.map((f: FileObject) => f.scan_status);
    expect(states).toEqual(["clean", "unscanned", undefined]);
  });
});

describe("downloadUrl: 409 SCAN-001 / SCAN-002 (memory-cloud v0.160.0+, #147)", () => {
  it("throws KaguraFileScanPendingError with retryAfter from Retry-After", async () => {
    const err = await downloadError(pending());
    expect(err).toBeInstanceOf(KaguraFileScanPendingError);
    // Subclasses the class the 409 had before, so existing handlers still catch it.
    expect(err).toBeInstanceOf(KaguraConnectionError);
    const scan = err as KaguraFileScanPendingError;
    expect(scan.retryAfter).toBe(30);
    expect(scan.fileId).toBe(FILE_ID);
    expect(scan.scanStatus).toBe("pending");
    expect(scan.code).toBe("SCAN-001");
    expect(scan.details).toEqual({ file_id: FILE_ID, scan_status: "pending" });
    expect(scan.retryable).toBe(true);
    expect(scan.message).toBe(`HTTP 409: ${PENDING_MESSAGE}`);
    expect(scan.name).toBe("KaguraFileScanPendingError");
  });

  it.each([
    ["absent", {}],
    ["not a number", { "Retry-After": "soon" }],
    ["an HTTP date", { "Retry-After": "Thu, 20 Nov 2026 01:00:00 GMT" }],
  ])("reads retryAfter as null when Retry-After is %s", async (_name, headers) => {
    const err = (await downloadError(pending(headers))) as KaguraFileScanPendingError;
    expect(err).toBeInstanceOf(KaguraFileScanPendingError);
    expect(err.retryAfter).toBeNull();
    expect(err.code).toBe("SCAN-001");
  });

  it.each(["infected", "error", "quarantined"])(
    "throws KaguraFileBlockedError carrying the server's scan_status %s",
    async (scanStatus) => {
      // The server's gate is an allow-list: any value but clean / unscanned / pending blocks.
      const err = await downloadError(blocked(scanStatus));
      expect(err).toBeInstanceOf(KaguraFileBlockedError);
      expect(err).toBeInstanceOf(KaguraConnectionError);
      expect(err).not.toBeInstanceOf(KaguraFileScanPendingError);
      const block = err as KaguraFileBlockedError;
      expect(block.scanStatus).toBe(scanStatus);
      expect(block.fileId).toBe(FILE_ID);
      expect(block.code).toBe("SCAN-002");
      expect(block.details).toEqual({ file_id: FILE_ID, scan_status: scanStatus });
      expect(block.retryable).toBe(false);
      expect(block.message).toBe(`HTTP 409: ${BLOCKED_MESSAGE}`);
      expect(block).not.toHaveProperty("retryAfter");
    },
  );

  it("reads a missing or mistyped details field as null, never as a failure", async () => {
    const err = (await downloadError(
      rest(409, { error: "SCAN-002", message: BLOCKED_MESSAGE, details: { file_id: 7 } }),
    )) as KaguraFileBlockedError;
    expect(err).toBeInstanceOf(KaguraFileBlockedError);
    expect(err.fileId).toBeNull();
    expect(err.scanStatus).toBeNull();
  });

  it("scrubs a message carrying credential markers, as the other typed errors do", async () => {
    const err = await downloadError(rest(409, { error: "SCAN-001", message: "Bearer kagura_secret", details: {} }));
    expect(err).toBeInstanceOf(KaguraFileScanPendingError);
    expect((err as Error).message).toBe("HTTP 409");
  });

  it("keeps a 404 KaguraNotFoundError: the server checks access before the scan gate", async () => {
    const err = await downloadError(
      rest(404, { error: "RES-001", message: `file not found: ${FILE_ID}`, details: {} }),
    );
    expect(err).toBeInstanceOf(KaguraNotFoundError);
    expect(err).not.toBeInstanceOf(KaguraConnectionError);
  });

  it("does not type a scan code on another status", async () => {
    const err = await downloadError(rest(400, { error: "SCAN-001", message: "odd", details: { file_id: FILE_ID } }));
    expect((err as Error).constructor).toBe(KaguraConnectionError);
    expect((err as KaguraError).code).toBe("SCAN-001");
  });

  it("leaves any other 409 as it was: the generic error, or a version conflict", async () => {
    const other = await downloadError(rest(409, { error: "RES-002", message: "conflict", details: {} }));
    expect((other as Error).constructor).toBe(KaguraConnectionError);
    expect((other as Error).message).toBe("HTTP 409: conflict");
    const conflict = await downloadError(
      rest(409, { error: "RES-002", message: "stale", details: { reason: "version_conflict" } }),
    );
    expect(conflict).toBeInstanceOf(KaguraVersionConflictError);
  });

  it("are exported from the package entry", () => {
    expect(sdk.KaguraFileScanPendingError).toBe(KaguraFileScanPendingError);
    expect(sdk.KaguraFileBlockedError).toBe(KaguraFileBlockedError);
    const options: sdk.KaguraFileScanPendingErrorOptions = { retryAfter: 30, code: "SCAN-001" };
    const built = new sdk.KaguraFileScanPendingError("HTTP 409", options);
    expect([built.retryAfter, built.code, built.fileId]).toEqual([30, "SCAN-001", null]);
    expect(new sdk.KaguraFileScanPendingError("HTTP 409").retryAfter).toBeNull();
  });
});

describe("upload: the reserve dedup 409 with scanning on (#147)", () => {
  it("returns a dedup hit whose scan is still pending, as any dedup hit", async () => {
    const fake = rest(409, {
      error: "RES-002",
      message: `file with sha256=${"0".repeat(64)} already exists in workspace; reuse file_id=${FILE_ID}`,
      details: {},
      existing_file: fileRow("pending"),
    });
    const result = await filesClient(fake).upload({ contextId: WS, source: new Uint8Array([1]), filename: "a.bin" });
    expect(result.id).toBe(FILE_ID);
    expect(result.scan_status).toBe("pending");
    expect(fake.requests).toHaveLength(1); // no PUT, no confirm
  });

  it("throws the plain conflict, as before, for a duplicate the scan blocked (no existing_file)", async () => {
    const fake = rest(409, {
      error: "RES-002",
      message:
        `file with sha256=${"0".repeat(64)} already exists in workspace; ` +
        "an earlier upload of this file was blocked by the malware scan",
      details: {},
    });
    const err = await filesClient(fake)
      .upload({ contextId: WS, source: new Uint8Array([1]), filename: "a.bin" })
      .catch((e: unknown) => e);
    expect((err as Error).constructor).toBe(KaguraConnectionError);
    expect((err as KaguraError).code).toBe("RES-002");
    expect((err as Error).message).toContain("blocked by the malware scan");
  });

  it("passes the scan size cap's validation message through", async () => {
    const message = "size_bytes must be in (0, 1048576], got 2097152 (the largest file the malware scan checks)";
    const fake = rest(422, { error: "VAL-001", message, details: { field: null } });
    const err = await filesClient(fake)
      .upload({ contextId: WS, source: new Uint8Array([1]), filename: "a.bin" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KaguraConnectionError);
    expect((err as Error).message).toBe(`HTTP 422: ${message}`);
  });
});
