/**
 * Progress events from the SDK's multi-step REST calls — the port of the
 * `logger=` hooks the Python SDK added in its #108 (`logger.py`), as a
 * callback rather than a logger class: a library should not write to
 * `process.stderr` itself, so the caller decides where an event goes and
 * how it looks. The `kagura-memory` bin renders them for `-v` and
 * `--progress`.
 *
 *     await files.upload({ contextId, source, onProgress: (e) => console.error(e) });
 *
 * An event is the Python CLI's NDJSON line without its `v` and `ts`, with
 * the same field presence: `msg` only when non-empty, `detail` only when it
 * has keys. An operation that emits anything ends with exactly one `success`
 * or `error` event, the last one, even when it throws — a consumer may wait
 * for the first of either. No callback means no events, as Python's library
 * default is silent. A callback that throws, or returns a promise that
 * rejects, is ignored: progress must never break the operation it reports
 * on. A returned promise is not awaited.
 */

/** Python's `_NDJSON_SCHEMA_VERSION`: the `v` the CLI stamps on every NDJSON line. */
export const PROGRESS_SCHEMA_VERSION = 1;

/**
 * `action` marks a step starting, `success` and `error` end the operation;
 * `detail`, `debug` and `warning` complete Python's closed set, and no
 * current SDK call emits them.
 */
export type ProgressKind = "action" | "detail" | "debug" | "success" | "warning" | "error";

/** One progress event. */
export interface ProgressEvent {
  /** The step, e.g. `reserve`, `upload`, `confirm`, `complete`. */
  stage: string;
  kind: ProgressKind;
  /** Human-readable text; absent rather than empty. */
  msg?: string;
  /**
   * Structured fields, snake_case as on the Python stream: `{ desc }` on an
   * action, the terminal state on `success` / `error` (counts, `file_id`,
   * how far a failed upload got). Absent rather than empty.
   */
  detail?: Record<string, unknown>;
}

/**
 * Receives each {@link ProgressEvent} as it happens. It may be `async`: the
 * promise it returns is not awaited, and a rejection is ignored.
 */
export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Hand `event` to `sink`, if there is one, and swallow anything it throws
 * or rejects with.
 *
 * @internal Shared by the SDK clients and the CLI; not part of the API.
 */
export function emitProgress(sink: ProgressCallback | undefined, event: ProgressEvent): void {
  if (sink === undefined) return;
  try {
    // `void` in the type does not stop an async callback: its promise would
    // otherwise reject unhandled, which ends a Node 15+ process.
    const returned: unknown = sink(event);
    if (typeof (returned as PromiseLike<unknown> | null)?.then === "function") {
      Promise.resolve(returned).catch(() => {});
    }
  } catch {
    // Python's "progress logging must never raise": the upload or import
    // being reported on is what matters.
  }
}
