/**
 * Request-side checks for the response budgets memory-cloud v0.82.0 added
 * (#1743) and recall's `full` (v0.114.0, #2124) — the port of the Python
 * SDK's `_validate_int_range` / `_validate_max_chars` (models.py).
 *
 * Internal. It lives in its own module so `KaguraClient` and the bootstrap
 * payload builder `AgentsClient` uses share one check without the REST
 * client importing the MCP one.
 */

import { pyRepr } from "./python.js";

/** The smallest `max_chars` a budgeted tool accepts (server `parse_max_chars`). */
export const MAX_CHARS_MIN = 10_000;
/** The largest `max_chars` a budgeted tool accepts. */
export const MAX_CHARS_MAX = 100_000;
/** recall's largest `full` (server `RECALL_MAX_FULL`, recall's own `k` limit). */
export const RECALL_FULL_MAX = 100;

/**
 * Refuse a request integer the server would refuse, before any request.
 *
 * A boolean, a string or a fractional number is not an integer here, as
 * on the server (`type(x) is int`). A `bigint` is Python's int and reads
 * as one.
 *
 * @param name The option's name, for the message.
 * @param hi The largest accepted value; omit to leave the range open above.
 * @returns The value to send, as a `number`.
 * @throws Error `<name> must be an integer between <lo> and <hi>, got <value>`
 *   (or `of at least <lo>` with no `hi`), the Python SDK's wording.
 */
export function validateIntRange(name: string, value: unknown, lo: number, hi?: number): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < lo ||
    (hi !== undefined && number > hi)
  ) {
    const bounds = hi === undefined ? `of at least ${lo}` : `between ${lo} and ${hi}`;
    throw new Error(`${name} must be an integer ${bounds}, got ${pyRepr(value)}`);
  }
  return number;
}

/**
 * Refuse a response budget the server would refuse: `maxChars` on
 * `recall`, `loadPinned`, `loadGuardrails` and `getAgentBootstrap` /
 * `AgentsClient.bootstrap` is characters of the reply, not tokens, an
 * integer in [10,000, 100,000].
 *
 * @throws Error if `value` is not an integer in that range.
 */
export function validateMaxChars(value: unknown): number {
  return validateIntRange("maxChars", value, MAX_CHARS_MIN, MAX_CHARS_MAX);
}
