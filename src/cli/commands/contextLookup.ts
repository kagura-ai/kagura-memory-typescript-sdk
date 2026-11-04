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
 * - Neither: `value` is used as given. It is a UUID (the dashed form is not
 *   looked up by name; another spelling matched no name), or blank.
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
 * `chosen` is trimmed first, as the server reads `name_contains`. A blank
 * value or a UUID in the dashed form is used as given and sends no request;
 * so does a value longer than any context name, which is unknown. Any
 * other value, a dashless 32-hex string included (a valid context name),
 * is looked up as a name: `firstPage()` is the plain first page, and a row
 * there with that id or name wins; when that page is not the whole list
 * (`has_more`, memory-cloud 0.82.0+), every page is searched with
 * {@link findContextByName}.
 *
 * The Python CLI reads the first page in its connection check, before it
 * looks at the value; this port reads it only for a value it looks up, so
 * a dashed UUID or no value keeps `setup claude` off the network. The
 * outcome is the same for a blank value or one longer than any context
 * name, which no row can match, and for a dashed UUID that is a row's id,
 * returned as given either way. It differs for a dashed UUID that is a
 * context's NAME (the server's `^[a-z0-9_-]+$` allows a lowercase one):
 * Python takes that row from its first page and writes the row's id; this
 * port uses the value as the id it is spelled as.
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
  if (!value || isCanonicalUuid(value)) return { value, context: null, unknown: false };
  // Python's len() counts code points.
  if ([...value].length > CONTEXT_NAME_MAX_CHARS) return { value, context: null, unknown: true };
  const first = await firstPage();
  // Python's `value in (ctx["id"], ctx.get("name"))`, kept for parity. A
  // dashed UUID returned above, so the id half matches only an id the
  // server spells otherwise.
  const row = rowsOf(first).find((ctx) => ctx.id === value || ctx.name === value);
  if (row !== undefined) return { value, context: row, unknown: false };
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
