/**
 * `kagura-memory files …` — R2 uploads with sha256 integrity binding.
 *
 * These are REST rather than MCP, so they take the shared config front
 * half (`resolveConfig`) and build a `FilesClient` instead of a
 * `KaguraClient`. Note the two different context ids: `--context-id` is
 * the *workspace*, `--binding-context-id` is the owning context used for
 * access control.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { requireArg, rejectExtraArgs, type Command, type CommandGroup } from "../command.js";
import { CliUsageError, parseRanged, parseTags } from "../parse.js";
import type { FlagSpec } from "../parseArgs.js";
import { mcpOptions, resolveConfig, restOptions, runAndPrint } from "../runClientCommand.js";

const CONTEXT_ID: FlagSpec = {
  name: "context-id",
  short: "c",
  type: "value",
  help: "Context (workspace) UUID",
};

const IMPORTANCE: FlagSpec = {
  name: "importance",
  type: "value",
  metavar: "FLOAT",
  help: "Importance 0.0-1.0 for --remember",
  defaultLabel: "0.5",
};

const upload: Command = {
  summary: "Upload a file to Kagura Memory Cloud.",
  args: "PATH",
  description:
    "  With --remember, also creates one summary memory linked to the\n" +
    "  uploaded file object. No LLM is involved: the summary is either the\n" +
    "  one you pass or is derived from the filename.",
  spec: {
    flags: [
      { ...CONTEXT_ID, help: "Target context (workspace) UUID" },
      { name: "content-type", short: "t", type: "value", help: "MIME type override (default: sniffed)" },
      {
        name: "binding-context-id",
        type: "value",
        help: "Owning context UUID to bind the file to for access control",
      },
      {
        name: "remember",
        type: "switch",
        help: "Also create a summary memory linked to the file (no LLM)",
      },
      { name: "summary", type: "value", help: "Summary for --remember (default: from the filename)" },
      { name: "type", type: "value", help: "Memory type for --remember", defaultLabel: "note" },
      IMPORTANCE,
      { name: "tags", type: "value", help: "Comma-separated tags for --remember" },
    ],
  },
  run: async (deps, args) => {
    const source = requireArg(args, 0, "PATH");
    rejectExtraArgs(args, 1);

    // Click declares `click.Path(exists=True, dir_okay=False)`, so the
    // check runs before anything else and reads as a usage error.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(source);
    } catch {
      throw new CliUsageError(
        `Invalid value for 'PATH': Path '${source}' does not exist.`,
      );
    }
    if (stat.isDirectory()) {
      throw new CliUsageError(`Invalid value for 'PATH': Path '${source}' is a directory.`);
    }

    const rawImportance = args.values.importance;
    const importance =
      rawImportance === undefined
        ? 0.5
        : parseRanged(IMPORTANCE, rawImportance, { min: 0, max: 1, rangeLabel: "0.0<=x<=1.0" });

    const { config, contextId } = resolveConfig(deps, args.values["context-id"]);
    const contentType = args.values["content-type"];
    const bindingContextId = args.values["binding-context-id"];
    const wantsMemory = args.flags.has("remember");
    const summary = args.values.summary ?? `File: ${path.basename(source)}`;
    const memoryType = args.values.type ?? "note";
    const tags = parseTags(args.values.tags);

    return runAndPrint(deps, async () => {
      const files = deps.makeFilesClient(restOptions(config));
      const uploaded = await files.upload({
        contextId,
        source,
        ...(contentType !== undefined ? { contentType } : {}),
        ...(bindingContextId !== undefined ? { bindingContextId } : {}),
      });
      if (!wantsMemory) return uploaded;

      // The memory is a second, separate call; a failure here must not
      // read as "the upload failed", so it names itself.
      const client = deps.makeClient(mcpOptions(config));
      try {
        const memory = await client.remember({
          contextId,
          summary,
          content: `Uploaded file ${uploaded.filename} (${uploaded.size_bytes} bytes, ${uploaded.content_type}).`,
          type: memoryType,
          importance,
          ...(tags ? { tags } : {}),
          details: { file_id: uploaded.id },
        });
        return { file: uploaded, memory };
      } finally {
        await client.close();
      }
    });
  },
};

const LIMIT: FlagSpec = {
  name: "limit",
  short: "l",
  type: "value",
  metavar: "INTEGER",
  help: "Max results (1-500)",
  defaultLabel: "50",
};

const list: Command = {
  summary: "List uploaded files in a context, newest first.",
  spec: {
    flags: [
      { ...CONTEXT_ID, help: "Context (workspace) UUID to list" },
      LIMIT,
      { name: "cursor", type: "value", help: "Forward-compat cursor (server v0.16+)" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const raw = args.values.limit;
    const limit =
      raw === undefined
        ? 50
        : parseRanged(LIMIT, raw, { min: 1, max: 500, rangeLabel: "1<=x<=500", integer: true });
    const cursor = args.values.cursor;
    const { config, contextId } = resolveConfig(deps, args.values["context-id"]);
    return runAndPrint(deps, () =>
      deps
        .makeFilesClient(restOptions(config))
        .list({ contextId, limit, ...(cursor !== undefined ? { cursor } : {}) }),
    );
  },
};

const deleteFile: Command = {
  summary: "Soft-delete a file by id.",
  args: "FILE_ID",
  spec: { flags: [{ ...CONTEXT_ID, help: "Context (workspace) UUID the file belongs to" }] },
  run: async (deps, args) => {
    const fileId = requireArg(args, 0, "FILE_ID");
    rejectExtraArgs(args, 1);
    const { config, contextId } = resolveConfig(deps, args.values["context-id"]);
    return runAndPrint(deps, async () => {
      await deps.makeFilesClient(restOptions(config)).delete(fileId, { contextId });
      // The REST call returns 204; Python prints the same confirmation
      // rather than an empty line.
      return { status: "success", file_id: fileId };
    });
  },
};

const downloadUrl: Command = {
  summary: "Print a short-lived presigned GET URL for a file.",
  args: "FILE_ID",
  spec: { flags: [{ ...CONTEXT_ID, help: "Context (workspace) UUID the file belongs to" }] },
  run: async (deps, args) => {
    const fileId = requireArg(args, 0, "FILE_ID");
    rejectExtraArgs(args, 1);
    const { config, contextId } = resolveConfig(deps, args.values["context-id"]);
    return runAndPrint(deps, () =>
      deps.makeFilesClient(restOptions(config)).downloadUrl(fileId, { contextId }),
    );
  },
};

export const FILES_GROUP: CommandGroup = {
  summary: "Upload, list, and manage files in Kagura Memory Cloud.",
  commands: { upload, list, delete: deleteFile, "download-url": downloadUrl },
};
