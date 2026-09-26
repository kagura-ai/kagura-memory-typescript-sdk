/**
 * Every command's `--help` shows its examples one per line, as the Python
 * CLI's `\b` blocks do from 0.41.1 (python-sdk #285). The blocks are
 * recorded from the Python CLI 0.42.0 (click 8.3.3, pydantic 2.13.4):
 * `kagura <command> --help`, with `kagura ` written `kagura-memory `.
 *
 * Not here: `ingest`, which this bin does not have, and `update-memory`,
 * whose examples plan 70a records with its --details flags.
 */

import { describe, expect, it } from "vitest";

import { isGroup, type Command, type CommandGroup } from "../../src/cli/command.js";
import { ROOT_COMMANDS, runCli, type CliDeps } from "../../src/cli/run.js";

const PYTHON_EXAMPLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["auth create-key", [
    "  Example:",
    "    kagura-memory auth create-key --user google_1234 --name ci-bot --expires-days 90",
  ]],
  ["auth list-keys", [
    "  Example:",
    "    kagura-memory auth list-keys --user google_1234",
  ]],
  ["auth login", [
    "  Examples:",
    "    kagura-memory auth login                      # read + write (default)",
    "    kagura-memory auth login --read-only          # read-only",
    "    kagura-memory auth login --scope \"memory:read memory:write profile:read\"  # custom",
    "    kagura-memory auth login --profile work",
    "    kagura-memory auth login --no-browser         # for SSH / headless",
    "    kagura-memory auth login --invite https://<host>/join/<token>  # invite-only sign-up",
  ]],
  ["auth refresh", [
    "  Examples:",
    "    kagura-memory auth refresh",
    "    kagura-memory auth refresh --scope \"memory:read\"                       # narrow to read-only",
    "    kagura-memory auth refresh --scope \"memory:read memory:write\"          # widen (triggers device flow)",
    "    kagura-memory auth refresh --profile work",
  ]],
  ["auth revoke-key", [
    "  Example:",
    "    kagura-memory auth revoke-key 42 --user google_1234 --yes",
  ]],
  ["context create", [
    "  Examples:",
    "    kagura-memory context create -n my-project",
    "    kagura-memory context create -n dev -d \"Development notes\" -s \"Project dev context\"",
  ]],
  ["context delete", [
    "  Examples:",
    "    kagura-memory context delete CTX_UUID",
    "    kagura-memory context delete CTX_UUID -y",
  ]],
  ["context list", [
    "  Examples:",
    "    kagura-memory context list",
    "    kagura-memory context list --name-contains auth --summary",
    "    kagura-memory context list --stats",
  ]],
  ["context search-config", [
    "  Examples:",
    "    kagura-memory context search-config CTX_UUID --semantic 0.5 --bm25 0.5",
    "    kagura-memory context search-config CTX_UUID --rerank --reranker voyage",
    "    kagura-memory context search-config CTX_UUID --rerank --reranker self_hosted",
  ]],
  ["context update", [
    "  Examples:",
    "    kagura-memory context update CTX_UUID -s \"Updated summary\"",
    "    kagura-memory context update CTX_UUID --lock",
    "    kagura-memory context update CTX_UUID --unlock",
  ]],
  ["edge create", [
    "  Examples:",
    "    kagura-memory edge create CTX_UUID SRC_UUID TGT_UUID",
    "    kagura-memory edge create CTX_UUID SRC_UUID TGT_UUID --type depends_on --weight 0.8",
  ]],
  ["edge delete", [
    "  Examples:",
    "    kagura-memory edge delete CTX_UUID SRC_UUID TGT_UUID",
    "    kagura-memory edge delete CTX_UUID SRC_UUID TGT_UUID -y",
  ]],
  ["edge list", [
    "  Examples:",
    "    kagura-memory edge list CTX_UUID MEM_UUID",
    "    kagura-memory edge list CTX_UUID MEM_UUID --min-weight 0.5 --type related_to",
  ]],
  ["edge update", [
    "  Examples:",
    "    kagura-memory edge update CTX_UUID SRC_UUID TGT_UUID --weight 0.9",
    "    kagura-memory edge update CTX_UUID SRC_UUID TGT_UUID --type related_to --weight 0.7",
  ]],
  ["explore", [
    "  Examples:",
    "    kagura-memory explore -m \"abc-123-def\"",
    "    kagura-memory explore -c dev -m \"abc-123\" --depth 3",
  ]],
  ["files delete", [
    "  Example:",
    "    kagura-memory files delete <file_id> -c <context-id>",
  ]],
  ["files download-url", [
    "  Example:",
    "    kagura-memory files download-url <file_id> -c <context-id>",
  ]],
  ["files list", [
    "  Example:",
    "    kagura-memory files list --context-id ctx-uuid",
  ]],
  ["files upload", [
    "  Examples:",
    "    kagura-memory files upload ./report.pdf --context-id ctx-uuid",
    "    kagura-memory files upload ./diagram.png --remember --tags \"design,arch\"",
  ]],
  ["forget", [
    "  Examples:",
    "    kagura-memory forget -m \"abc-123-def\"",
    "    kagura-memory forget -q \"outdated test data\" -k 5",
    "    kagura-memory forget -c dev -m \"memory-uuid\"",
  ]],
  ["guardrails digest", [
    "  Examples:",
    "    kagura-memory guardrails digest CTX_UUID",
    "    kagura-memory guardrails digest CTX_UUID --out AGENTS.md",
    "    kagura-memory guardrails digest CTX_UUID --target instructions --profile core",
  ]],
  ["guardrails load", [
    "  Examples:",
    "    kagura-memory guardrails load",
    "    kagura-memory guardrails load CTX_UUID --cap 200",
  ]],
  ["measure record", [
    "  Examples:",
    "    kagura-memory measure record <context-id> weight_kg 71.5 --unit kg",
    "    kagura-memory measure record <context-id> pnl_usd -120 --at 2026-09-01T00:00:00Z",
  ]],
  ["measure series", [
    "  Examples:",
    "    kagura-memory measure series <context-id> weight_kg --period week",
    "    kagura-memory measure series <context-id> pnl_usd --agg sum --start 2026-01-01T00:00:00",
  ]],
  ["recall", [
    "  Examples:",
    "    kagura-memory recall \"FastAPI dependency injection\"",
    "    kagura-memory recall \"OAuth2 implementation\" -k 10",
    "    kagura-memory recall -c dev \"error handling pattern\"",
    "    kagura-memory recall \"latency-sensitive lookup\" --no-rerank",
    "    kagura-memory recall \"project context\" --trusted-only",
  ]],
  ["reference", [
    "  Examples:",
    "    kagura-memory reference -m \"abc-123-def\"",
    "    kagura-memory reference -c dev -m \"abc-123-def\"",
  ]],
  ["remember", [
    "  Examples:",
    "    kagura-memory remember -s \"FastAPI DI pattern\" --content \"Use Depends()...\"",
    "    kagura-memory remember -c dev -s \"OAuth2 setup\" --content \"...\" --tags \"auth,oauth\"",
    "    kagura-memory remember -s \"Spec\" --content \"$(cat spec.md)\" \\",
    "      --source-uri file:///spec.md --source-type file",
    "    kagura-memory remember -s \"Coffee with Sato\" --content \"...\" \\",
    "      --location \"35.68,139.76,Tokyo HQ\"",
  ]],
  ["resource events", [
    "  Examples:",
    "    kagura-memory resource events products",
    "    kagura-memory resource events products --op upsert --limit 20",
    "    kagura-memory resource events products --since 2026-06-01T00:00:00Z",
    "    kagura-memory resource events products --cursor \"eyJ...\"",
  ]],
  ["resource import", [
    "  Examples:",
    "    kagura-memory resource import -r products -k TOKEN -f products.csv",
    "    kagura-memory resource import -r products -k TOKEN -f data.jsonl",
    "    cat items.json | kagura-memory resource import -r products -k TOKEN --format json",
  ]],
  ["resource indexer-status", [
    "  Examples:",
    "    kagura-memory resource indexer-status -r products",
  ]],
  ["resource ingest", [
    "  Examples:",
    "    kagura-memory resource ingest -r products -k KEY --doc-id SKU-001 -p '{\"name\":\"Widget\",\"price\":9.99}'",
    "    kagura-memory resource ingest -r products -k KEY --doc-id SKU-999 --op delete",
  ]],
  ["resource ingest-batch", [
    "  Examples:",
    "    kagura-memory resource ingest-batch -r products -k KEY -f events.json",
  ]],
  ["resource list", [
    "  Examples:",
    "    kagura-memory resource list",
  ]],
  ["resource schema", [
    "  Examples:",
    "    kagura-memory resource schema -r products",
    "    kagura-memory resource schema -r products -v 2",
  ]],
  ["resource setup", [
    "  Examples:",
    "    kagura-memory resource setup -r products",
    "    kagura-memory resource setup -r products -n product-catalog",
    "    kagura-memory resource setup -r slack-messages -d \"Slack sync\" -q 5000",
  ]],
  ["resource stats", [
    "  Examples:",
    "    kagura-memory resource stats -r products",
  ]],
  ["resource tokens create", [
    "  Examples:",
    "    kagura-memory resource tokens create -r products",
    "    kagura-memory resource tokens create -r slack-messages -d \"Slack integration\" -q 5000",
  ]],
  ["resource tokens list", [
    "  Examples:",
    "    kagura-memory resource tokens list",
    "    kagura-memory resource tokens list --resource-id products",
  ]],
  ["resource tokens revoke", [
    "  Examples:",
    "    kagura-memory resource tokens revoke 42",
  ]],
  ["resource tokens update", [
    "  Examples:",
    "    kagura-memory resource tokens update 42 -d \"New description\"",
    "    kagura-memory resource tokens update 42 -q 2000",
  ]],
  ["setup claude", [
    "  Examples:",
    "    kagura-memory setup claude",
    "    kagura-memory setup claude --profile default        # OAuth via kagura-mcp (recommended)",
    "    kagura-memory setup claude --profile default --scope user   # one entry for every project",
    "    kagura-memory setup claude --profile default --guardrails off --tool-profile core",
    "    kagura-memory setup claude --api-key kagura_xxx --mcp-url http://localhost:8080/mcp/w/{workspace_id}",
    "    kagura-memory setup claude -y --api-key kagura_xxx --context-id my-project",
    "    kagura-memory setup claude --no-commands      # plugin users: its /kagura-memory:* instead",
    "    kagura-memory setup claude --no-auto-context  # always show full context list",
  ]],
  ["setup codex", [
    "  Examples:",
    "    kagura-memory setup codex --profile default",
    "    kagura-memory setup codex --profile default --context-id CTX_UUID",
    "    kagura-memory setup codex --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
    // Python's fourth line, `--url-form --oauth`, comes with that flag (plan 70c), which adds it here.
    "    kagura-memory setup codex --profile default --dry-run",
  ]],
  ["setup hermes", [
    "  Examples:",
    "    kagura-memory setup hermes --profile default",
    "    kagura-memory setup hermes --profile default --context-id CTX_UUID --agents-md",
    "    kagura-memory setup hermes --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
    // Python's fourth line, `--url-form --oauth`, comes with that flag (plan 70c), which adds it here.
    "    kagura-memory setup hermes --profile default -y     # print the block only",
  ]],
  ["setup openclaw", [
    "  Examples:",
    "    kagura-memory setup openclaw --profile default",
    "    kagura-memory setup openclaw --profile default --context-id CTX_UUID --agents-md",
    "    kagura-memory setup openclaw --url-form --mcp-url https://memory.kagura-ai.com/mcp/w/WS_ID",
    // Python's fourth line, `--url-form --oauth`, comes with that flag (plan 70c), which adds it here.
    "    kagura-memory setup openclaw --profile default --force",
  ]],
  ["workspace invite create", [
    "  Example:",
    "    kagura-memory workspace invite create new@example.com --role member -c <context-uuid>",
  ]],
  ["workspace invite list", [
    "  Example:",
    "    kagura-memory workspace invite list",
  ]],
  ["workspace invite revoke", [
    "  Example:",
    "    kagura-memory workspace invite revoke 7",
  ]],
  ["workspace member add", [
    "  Example:",
    "    kagura-memory workspace member add google_1234 --role member",
  ]],
  ["workspace member list", [
    "  Example:",
    "    kagura-memory workspace member list -w <workspace-uuid>",
  ]],
  ["workspace member remove", [
    "  Example:",
    "    kagura-memory workspace member remove google_1234 --yes",
  ]],
  ["workspace member set-role", [
    "  Example:",
    "    kagura-memory workspace member set-role google_1234 --role admin",
  ]],
];

/** Commands with an Examples block that this table leaves to another plan, or aliases. */
const NOT_IN_TABLE: ReadonlySet<string> = new Set(["update-memory", "contexts"]);

function commandPaths(entries: Record<string, Command | CommandGroup>, prefix: string[] = []): string[][] {
  return Object.entries(entries).flatMap(([name, entry]) =>
    isGroup(entry) ? commandPaths(entry.commands, [...prefix, name]) : [[...prefix, name]],
  );
}

async function help(argv: string[]): Promise<string> {
  const out: string[] = [];
  const deps = { write: (l: string) => void out.push(l), writeError: () => {} } as unknown as CliDeps;
  expect(await runCli([...argv, "--help"], deps)).toBe(0);
  return out.join("\n");
}

/** The `Example:` / `Examples:` line and the lines under it, up to the next blank one. */
function exampleBlock(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "  Examples:" || l === "  Example:");
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines.slice(start, end === -1 ? undefined : end);
}

describe("--help examples (python-sdk #285)", () => {
  it.each(PYTHON_EXAMPLES)("%s shows the Python CLI's examples, one per line", async (command, block) => {
    expect(exampleBlock(await help(command.split(" ")))).toEqual(block);
  });

  it("has no command with examples that the table misses", async () => {
    const table = new Set(PYTHON_EXAMPLES.map(([command]) => command));
    const missing: string[] = [];
    for (const argv of commandPaths(ROOT_COMMANDS)) {
      const name = argv.join(" ");
      if (exampleBlock(await help(argv)).length > 0 && !table.has(name) && !NOT_IN_TABLE.has(name)) {
        missing.push(name);
      }
    }
    expect(missing).toEqual([]);
  });
});
