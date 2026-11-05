/**
 * A context given to `setup` by id or by name, resolved as the Python CLI
 * 0.44.0 resolves it (python-sdk#309): `setup_claude._lookup_context`,
 * `_find_context_by_name` and `setup_harness._dry_run_context`.
 *
 * Since memory-cloud v0.82.0 (#1743) `list_contexts` returns at most 100
 * contexts a page, so a name past the first page is looked up with
 * `name_contains` (v0.73.0+) and the cursor, on every page. An older server
 * returns every context in one reply with no `has_more`, and gets no
 * second request.
 */

import { iterPages, type ListContextsOptions } from "../../client.js";
import type { ContextListItem, ListContextsResponse } from "../../models.js";
import { isCanonicalUuid, pyStrip, uuidOrNone } from "../../pyCompat.js";
import { pyRepr, pyTruthy } from "../../python.js";
import { CliError } from "../parse.js";

/** Python setup_claude._validate_context_id, applied after name resolution. */
export function validateContextId(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new CliError(`Invalid context_id: ${pyRepr(value)} — must be alphanumeric, hyphens, or underscores only`);
  }
}

/**
 * The longest `name_contains` `list_contexts` takes (memory-cloud
 * `_LIST_CONTEXTS_NAME_FILTER_MAX_LENGTH`), which is also the longest
 * context name the server creates.
 */
export const CONTEXT_NAME_MAX_CHARS = 100;

/** `KaguraClient.listContexts`, or a test's stand-in. */
export type ListContexts = (options: ListContextsOptions) => Promise<ListContextsResponse>;

/**
 * What {@link lookupContext} found for a context id or name: one of three
 * — Python's `_ContextLookup`.
 *
 * - Matched: `context` is the row whose id or exact name `value` is.
 * - Unknown (`unknown`): `value` names no context the credential can see.
 *   It is not a UUID, and either every page was searched for the name or
 *   it is longer than any context name.
 * - Neither: `value` is used as given. It is a UUID that matched no row
 *   (the dashed form stops after the first page), or blank.
 *
 * `value` is the value looked up, trimmed: what is compared, sent and used.
 */
export interface ContextLookup {
  value: string;
  context: ContextListItem | null;
  unknown: boolean;
}

/** The rows of a page that have an id (Python's `isinstance(ctx, dict) and ctx.get("id")`). */
function rowsOf(page: ListContextsResponse): ContextListItem[] {
  const rows: unknown = (page as { contexts?: unknown }).contexts;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is ContextListItem =>
      typeof row === "object" && row !== null && !Array.isArray(row) && pyTruthy((row as { id?: unknown }).id),
  );
}

/**
 * The context named exactly `name`, from `list_contexts(name_contains=name)`
 * — Python's `_find_context_by_name`.
 *
 * `name_contains` is the server's case-insensitive substring match on the
 * name or the display name (memory-cloud 0.73.0+), so a page can hold other
 * contexts too: only a row whose `name` equals `name` as the server stores
 * it is taken; a display name never counts (list rows do not carry it).
 * Pages are followed with `cursor` while `has_more` says more match
 * (0.82.0+), at most 50, the bound `listAgents` uses. The first match in
 * the server's most-recently-used order wins, and no page after it is
 * fetched.
 *
 * @returns The matching row, or null when no page has one.
 * @throws KaguraResponseError (operation `list_contexts`) when a page says
 *   `has_more` without a usable `next_cursor` or repeats an earlier one,
 *   or the matches do not end within 50 pages.
 */
export async function findContextByName(name: string, listContexts: ListContexts): Promise<ContextListItem | null> {
  const pages = iterPages("list_contexts", (cursor) =>
    listContexts(cursor === undefined ? { nameContains: name } : { nameContains: name, cursor }),
  );
  for await (const page of pages) {
    const match = rowsOf(page).find((row) => row.name === name);
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * Resolve `chosen`, a context id or an exact name — Python's
 * `_lookup_context`.
 *
 * `chosen` is trimmed first. Blank or overlong values need no lookup.
 * Otherwise `firstPage()` is read and its first row with that ID or exact
 * name wins, including a UUID-shaped name. A canonical UUID not found
 * there is used as an ID without fetching more pages, as in Python.
 * Other values (including dashless UUIDs) search every matching page with
 * {@link findContextByName} when the first page says `has_more`.
 *
 * @throws whatever `firstPage` or `listContexts` throws, and
 *   KaguraResponseError from {@link findContextByName}.
 */
export async function lookupContext(
  chosen: string,
  firstPage: () => Promise<ListContextsResponse>,
  listContexts: ListContexts,
): Promise<ContextLookup> {
  const value = pyStrip(chosen);
  if (!value) return { value, context: null, unknown: false };
  // Python's len() counts code points.
  if ([...value].length > CONTEXT_NAME_MAX_CHARS) return { value, context: null, unknown: true };
  const first = await firstPage();
  // Python checks the first page's IDs and names before interpreting a
  // dashed UUID as an ID. A context can itself have a UUID-shaped name.
  const row = rowsOf(first).find((ctx) => ctx.id === value || ctx.name === value);
  if (row !== undefined) return { value, context: row, unknown: false };
  if (isCanonicalUuid(value)) return { value, context: null, unknown: false };
  if ((first as { has_more?: unknown }).has_more === true) {
    const named = await findContextByName(value, listContexts);
    if (named !== null) return { value, context: named, unknown: false };
  }
  // Every page was searched for the name; another spelling of a UUID is still an id.
  return { value, context: null, unknown: uuidOrNone(value) === null };
}

/**
 * The stderr line `setup claude` prints before it uses an unknown value as
 * a raw context id — the Python CLI 0.44.0's words.
 */
export function unknownContextWarning(value: string): string {
  return `  Warning: no context named ${pyRepr(value)} is visible to this credential; using it as a raw context id.`;
}

/**
 * `chosen` as `--dry-run` shows it — Python's `_dry_run_context`: a UUID
 * in the dashed form, canonical, or a placeholder for anything else, which
 * a real run may first look up as a context name (a dry run makes no
 * network call). A dashless, `{braced}` or `urn:uuid:` spelling gets the
 * placeholder too.
 */
export function dryRunContext(chosen: string): string {
  const value = pyStrip(chosen);
  return (isCanonicalUuid(value) ? uuidOrNone(value) : null) ?? `<UUID of context ${value}>`;
}
