/**
 * `kagura-memory files …` — R2 uploads with sha256 integrity binding.
 *
 * These are REST rather than MCP, so they build a `FilesClient` instead of
 * a `KaguraClient` — from the one credential the chain resolves, with the
 * workspace taken from that same source (#115; see `credentialSource.ts`),
 * as Python's `_run_files_command` does. Note the two different context
 * ids: `--context-id` is the *workspace*, `--binding-context-id` is the
 * owning context used for access control.
 */

import * as fs from "node:fs";

import { excMessage, KaguraError } from "../../errors.js";
import type { FilesClient } from "../../filesClient.js";
import { realPath } from "../../guardrailExport.js";
import type { FileObject } from "../../models.js";
import { emitProgress, type ProgressEvent } from "../../progress.js";
import { pyRepr } from "../../python.js";
import { requireArg, rejectExtraArgs, type Command, type CommandDeps, type CommandGroup } from "../command.js";
import { pairWorkspaceCredential } from "../credentialSource.js";
import { cliErrorMessage, formatJson } from "../output.js";
import { CliError, CliUsageError, parseRanged, parseTags, quote } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { parseProgress, PROGRESS_FLAG, resolveProgress, VERBOSE_FLAG } from "../progress.js";

const CONTEXT_ID: FlagSpec = {
  name: "context-id",
  short: "c",
  type: "value",
  help: "Context (workspace) UUID the file belongs to",
};

/**
 * Pair the workspace with the credential, build the client from that
 * credential, run `operation` and print what it returns, as is — the port
 * of `_run_files_command`, which echoes a string the operation formatted.
 *
 * Failing to pair prints Python's #115 message; any other failure,
 * building the client included, prints `Error: …` with the quota and plan
 * lines. Both exit 1.
 */
async function runFilesCommand(
  deps: CommandDeps,
  contextId: string | undefined,
  operation: (files: FilesClient, workspaceId: string) => Promise<string>,
): Promise<number> {
  const { auth, workspaceId, workspaceIdHint } = pairWorkspaceCredential(deps, contextId);
  try {
    const files = deps.makeFilesClient(auth, workspaceIdHint);
    deps.write(await operation(files, workspaceId));
    return 0;
  } catch (e) {
    throw e instanceof CliError || e instanceof CliUsageError ? e : new CliError(cliErrorMessage(e));
  }
}

const IMPORTANCE: FlagSpec = {
  name: "importance",
  type: "value",
  metavar: "FLOAT",
  help: "Importance 0.0-1.0 for the --remember memory.",
  defaultLabel: "0.5",
};

/**
 * Click's `click.Path(exists=True, dir_okay=False)` check of PATH, in its
 * words: a usage error naming the path by its repr.
 */
function checkUploadPath(source: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new CliUsageError(`Invalid value for 'PATH': File ${quote(source)} does not exist.`);
  }
  if (stat.isDirectory()) {
    throw new CliUsageError(`Invalid value for 'PATH': File ${quote(source)} is a directory.`);
  }
  try {
    fs.accessSync(source, fs.constants.R_OK);
  } catch {
    throw new CliUsageError(`Invalid value for 'PATH': File ${quote(source)} is not readable.`);
  }
}

/**
 * `urllib.parse.quote(text, safe="/")`: every UTF-8 byte percent-encoded,
 * upper-case, except letters, digits, `_.-~` and `/`. Stricter than
 * `pathToFileURL`, which leaves `(`, `!`, `;` and the like alone.
 */
function pyQuote(text: string): string {
  let out = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const c = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.~/-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Python's `PurePath.as_uri()` for an absolute path: `file://` and the
 * quoted path on POSIX; on Windows `file:///C:/…` for a drive and
 * `file://host/share/…` for a UNC path.
 */
export function pathAsUri(absolute: string, windows: boolean): string {
  if (!windows) return `file://${pyQuote(absolute)}`;
  const posix = absolute.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(posix)) return `file:///${posix.slice(0, 2)}${pyQuote(posix.slice(2))}`;
  return `file:${pyQuote(posix)}`;
}

/**
 * The `source_uri` of a `--remember` memory: `path.resolve().as_uri()`,
 * symlinks resolved. Python's resolve is not strict, so a file gone by the
 * time the memory is written still has a URI rather than failing the
 * write after the upload succeeded.
 */
function fileUri(source: string): string {
  return pathAsUri(realPath(source), process.platform === "win32");
}

interface RememberFileOptions {
  summary: string | undefined;
  memoryType: string;
  importance: number;
  tags: string[] | undefined;
}

/**
 * Create the summary memory linked to an uploaded file object — port of
 * `_remember_file_object`. No LLM: the summary is the one given, else the
 * server's filename.
 *
 * The client is built with no options, as Python builds `KaguraClient()`:
 * it then runs the same credential chain the upload used, so the memory
 * is written by the identity that owns the workspace. Passing the config's
 * key would force that key over an env key or an OAuth profile, and a
 * cross-workspace 403.
 *
 * @throws KaguraError when the write reports no `memory_id`: printing that
 *   payload as the memory would read as success.
 */
async function rememberFileObject(
  deps: CommandDeps,
  contextId: string,
  source: string,
  file: FileObject,
  options: RememberFileOptions,
): Promise<unknown> {
  const client = deps.makeClient({});
  try {
    const result = await client.remember({
      contextId,
      summary: options.summary || `File: ${file.filename}`,
      content:
        `Uploaded file \`${file.filename}\` (${file.size_bytes} bytes, ${file.content_type}). ` +
        `Stored as file_object ${file.id}.`,
      type: options.memoryType,
      importance: options.importance,
      ...(options.tags ? { tags: options.tags } : {}),
      sourceUri: fileUri(source),
      sourceType: "file",
      details: {
        file_id: file.id,
        sha256: file.sha256,
        size_bytes: file.size_bytes,
        content_type: file.content_type,
      },
    });
    const record = result as unknown as Record<string, unknown> | null;
    if (typeof record !== "object" || record === null || Array.isArray(record) || !record.memory_id) {
      throw new KaguraError(`memory write reported an error: ${pyRepr(result)}`);
    }
    return result;
  } finally {
    await client.close();
  }
}

const upload: Command = {
  summary: "Upload a file to Kagura Memory Cloud.",
  args: "PATH",
  description:
    "  With --remember, also creates one summary memory linked to the\n" +
    "  file_object (provenance + details.file_id back-reference), without\n" +
    "  invoking an LLM — works for binaries and keyless environments. For\n" +
    "  LLM-extracted section memories use `kagura ingest` instead.\n\n" +
    "  Examples:\n" +
    "    kagura-memory files upload ./report.pdf --context-id ctx-uuid\n" +
    '    kagura-memory files upload ./diagram.png --remember --tags "design,arch"',
  spec: {
    flags: [
      { ...CONTEXT_ID, help: "Target context (workspace) UUID" },
      { name: "content-type", short: "t", type: "value", help: "MIME type override (default: sniffed)" },
      {
        name: "binding-context-id",
        type: "value",
        help:
          "Optional owning context UUID to bind the file to for access control " +
          "(server v0.41.0+). Distinct from --context-id (the workspace). Must be a " +
          "write-accessible context within the workspace. Omit for a workspace-scoped file.",
      },
      {
        name: "remember",
        type: "switch",
        help: "Also create a summary memory linked to the uploaded file_object (no LLM).",
      },
      {
        name: "summary",
        type: "value",
        help: "Summary for the --remember memory (default: derived from filename).",
      },
      { name: "type", type: "value", help: "Memory type for the --remember memory.", defaultLabel: "note" },
      IMPORTANCE,
      { name: "tags", type: "value", help: "Comma-separated tags for the --remember memory." },
      VERBOSE_FLAG,
      PROGRESS_FLAG,
    ],
  },
  run: async (deps, args) => {
    // Click converts every option given before any argument, wherever
    // they sit on the command line: `upload missing.txt --importance 2`
    // reports the importance.
    const rawImportance = args.values.importance;
    const importance =
      rawImportance === undefined
        ? 0.5
        : parseRanged(IMPORTANCE, rawImportance, { min: 0, max: 1, rangeLabel: "0.0<=x<=1.0" });
    const progress = parseProgress(args);

    const source = requireArg(args, 0, "PATH");
    checkUploadPath(source);
    rejectExtraArgs(args, 1);

    // Refused rather than dropped: without --remember they would do
    // nothing, and the caller clearly meant them to.
    const wantsMemory = args.flags.has("remember");
    const summary = args.values.summary;
    const rawTags = args.values.tags;
    if (!wantsMemory && (summary !== undefined || rawTags !== undefined)) {
      throw new CliUsageError("--summary and --tags require --remember.");
    }

    const contentType = args.values["content-type"];
    const bindingContextId = args.values["binding-context-id"];
    const memoryType = args.values.type ?? "note";
    const tags = parseTags(rawTags);
    const onProgress = resolveProgress(args.counts.verbose ?? 0, progress, deps.writeError);

    return runFilesCommand(deps, args.values["context-id"], async (files, contextId) => {
      // With --remember the upload's success is not the end of the
      // command: hold it until the memory is written, so that a stream
      // whose last event says success never belongs to a command that
      // failed. (Python emits it before the memory write.)
      let held: ProgressEvent | undefined;
      const sink =
        wantsMemory && onProgress !== undefined
          ? (event: ProgressEvent) => {
              if (event.kind === "success") held = event;
              else onProgress(event);
            }
          : onProgress;
      const uploaded = await files.upload({
        contextId,
        source,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(bindingContextId !== undefined ? { bindingContextId } : {}),
        ...(sink !== undefined ? { onProgress: sink } : {}),
      });
      if (!wantsMemory) return formatJson(uploaded);

      let memory: unknown;
      try {
        memory = await rememberFileObject(deps, contextId, source, uploaded, {
          summary,
          memoryType,
          importance,
          tags,
        });
      } catch (e) {
        // The upload succeeded: name the file_id, or the caller re-runs
        // and stores a duplicate.
        const message =
          `File uploaded (file_id=${uploaded.id}), but creating the linked memory failed: ` +
          `${excMessage(e)}. The file_object is stored; retry the memory write separately ` +
          "or reference it by file_id.";
        emitProgress(onProgress, {
          stage: "complete",
          kind: "error",
          msg: message,
          detail: {
            reserved_file_id: uploaded.id,
            uploaded: true,
            confirm_started: true,
            confirmed: true,
          },
        });
        throw new CliError(cliErrorMessage(e, message));
      }
      if (held !== undefined) emitProgress(onProgress, held);
      return formatJson({ file: uploaded, memory });
    });
  },
};

const LIMIT: FlagSpec = {
  name: "limit",
  short: "l",
  type: "value",
  metavar: "INTEGER",
  help: "Max results (1-500)",
};

const list: Command = {
  summary: "List uploaded files in a context, newest first.",
  description: "  Example:\n    kagura-memory files list --context-id ctx-uuid",
  spec: {
    flags: [
      { ...CONTEXT_ID, help: "Context (workspace) UUID to list" },
      LIMIT,
      { name: "cursor", type: "value", help: "Forward-compat cursor (server v0.16+)" },
    ],
  },
  run: async (deps, args) => {
    const raw = args.values.limit;
    const limit =
      raw === undefined
        ? 50
        : parseRanged(LIMIT, raw, { min: 1, max: 500, rangeLabel: "1<=x<=500", integer: true });
    rejectExtraArgs(args);
    const cursor = args.values.cursor;
    return runFilesCommand(deps, args.values["context-id"], async (files, contextId) =>
      formatJson(await files.list({ contextId, limit, ...(cursor !== undefined ? { cursor } : {}) })),
    );
  },
};

/** The `download-url` / `delete` paragraph, in Python's words (its RST backticks included). */
const OWNING_CONTEXT =
  "  The owning context (workspace) is required (server v0.41.0): pass\n" +
  "  ``--context-id`` or set it in your OAuth profile / .kagura.json.";

const deleteFile: Command = {
  summary: "Soft-delete a file by id.",
  args: "FILE_ID",
  description: `${OWNING_CONTEXT}\n\n  Example:\n    kagura-memory files delete <file_id> -c <context-id>`,
  spec: { flags: [CONTEXT_ID] },
  run: async (deps, args) => {
    const fileId = requireArg(args, 0, "FILE_ID");
    rejectExtraArgs(args, 1);
    return runFilesCommand(deps, args.values["context-id"], async (files, contextId) => {
      await files.delete(fileId, { contextId });
      return `Deleted ${fileId}`;
    });
  },
};

const downloadUrl: Command = {
  summary: "Print a short-lived presigned GET URL for a file.",
  args: "FILE_ID",
  description:
    `${OWNING_CONTEXT}\n\n  Example:\n` +
    "    kagura-memory files download-url <file_id> -c <context-id>",
  spec: { flags: [CONTEXT_ID] },
  run: async (deps, args) => {
    const fileId = requireArg(args, 0, "FILE_ID");
    rejectExtraArgs(args, 1);
    // The bare URL, as Python echoes it: `curl "$(kagura-memory files
    // download-url …)"` must not receive JSON quotes.
    return runFilesCommand(deps, args.values["context-id"], (files, contextId) =>
      files.downloadUrl(fileId, { contextId }),
    );
  },
};

export const FILES_GROUP: CommandGroup = {
  summary: "Upload, list, and manage files in Kagura Memory Cloud.",
  commands: { upload, list, delete: deleteFile, "download-url": downloadUrl },
};
