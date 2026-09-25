/**
 * An id as one segment of a REST path: the guard every id the SDK
 * interpolates into a path goes through (#66).
 *
 * @internal Not exported from the package entry point.
 */

/** A UTF-16 surrogate with no partner, which `encodeURIComponent` refuses. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * `value` percent-encoded as a single path segment.
 *
 * Encoded whole, so a `/`, `?`, `#` or `%` stays inside the segment: an id
 * typed as `x?workspace_id=…` or `a/b` can no longer reach another route or
 * add a query. Three values are refused rather than encoded, since no
 * encoding neutralizes them: `.` and `..` are unreserved characters, left
 * as they are, and URL resolution then drops the segment or climbs out of
 * it (`GET /api/v1/files/../download-url` is sent as
 * `GET /api/v1/download-url`); and an empty one makes `//`, which the
 * server routes elsewhere too. The Python SDK sends all of them as typed.
 *
 * A lone surrogate is written as U+FFFD, as `fetch` writes one in a URL,
 * rather than failing with `encodeURIComponent`'s `URIError`.
 *
 * @param label The parameter's name, for the error (`fileId`).
 * @param what What the value should be, for the error (`a file id`).
 * @throws Error when `value` is empty, `.` or `..`.
 */
export function pathSegment(value: string, label: string, what: string): string {
  const text = String(value);
  if (text === "" || text === "." || text === "..") {
    throw new Error(
      `${label} must be ${what}, got ${JSON.stringify(text)}: as a URL path segment it ` +
        "would address a different endpoint",
    );
  }
  return encodeURIComponent(text.replace(LONE_SURROGATE, "�"));
}
