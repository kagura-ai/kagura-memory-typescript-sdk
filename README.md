<p align="center">
  <strong>Kagura Memory SDK for TypeScript</strong> — Node.js client for <a href="https://github.com/kagura-ai/memory-cloud">Kagura Memory Cloud</a>
</p>

## What is this?

This SDK connects your TypeScript/JavaScript code to [Kagura Memory Cloud](https://github.com/kagura-ai/memory-cloud), giving AI agents the ability to **remember, search, and learn** from past interactions. It is a TypeScript port of the [Python SDK](https://github.com/kagura-ai/kagura-memory-python-sdk) core:

| Client | Protocol | Use Case |
|--------|----------|----------|
| **`KaguraClient`** | MCP (JSON-RPC) | Direct memory ops — remember, recall, explore, reference, forget |
| **`ResourceClient`** | REST API | External data ingestion — push data from Slack, CI/CD, CRM into Kagura |
| **`FilesClient`** | REST + presigned PUT | File uploads with sha256 integrity binding (R2) |
| **`WorkspaceClient`** | REST API | Workspace member, invitation, and API key management |
| **`SecretClient`** | REST API | [Zero-knowledge secrets](#zero-knowledge-secrets) — age-encrypted on your machine, opaque to the server |
| **`AgentsClient`** | REST API | Agent bootstrap for API-key-only callers (no MCP session) |
| **`MemoryClient`** | REST API | [Tool guardrails](#tool-guardrails-over-rest-memory-cloud-v0740) for API-key-only callers — the `AGENTS.md` export digest and the guardrail set |

A `kagura-memory` command-line tool ships alongside it, mirroring the Python
CLI's `kagura` command — see [Command line](#command-line).

For Claude Desktop, the [MCPB extension](docs/mcpb.md) provides browser sign-in
and a refresh-aware connection without Python or a global CLI install. The npm
package also includes `kagura-memory-mcp`, a transparent stdio/HTTP proxy.

## Installation

```bash
npm install kagura-memory
```

Requires Node.js >= 18 (native `fetch`). Zero runtime dependencies —
the one optional peer dependency, for
[zero-knowledge secrets](#the-crypto-package-is-opt-in), is never installed
unless you ask for it.

Targets memory-cloud **v0.75.0** (`MIN_SERVER_VERSION`).
`checkServerVersion()` warns, and never throws, on an older server, which
still answers: it ignores options it predates, leaves out fields it
predates, and reports a tool it predates as not found. A pre-release of
the minimum (`0.75.0-rc1`) counts as older, and a version it cannot read
(`0.75`, `main-abc123`) gets no warning, as in the Python SDK. The method
notes below say which server version a feature needs.

## Quick Start

```ts
import { KaguraClient } from "kagura-memory";

// Credentials resolve automatically: explicit apiKey > KAGURA_API_KEY env
// > OAuth profile (~/.kagura/credentials.json, shared with the Python CLI)
// > .kagura.json
const client = new KaguraClient();

// Store a memory
const stored = await client.remember({
  contextId: "your-context-id",
  summary: "User prefers TypeScript strict mode",
  content: "Enabled strict + noUncheckedIndexedAccess in all new projects.",
  type: "note",
  tags: ["typescript", "preferences"],
});

// Search memories (hybrid semantic + keyword)
const hits = await client.recall({
  contextId: "your-context-id",
  query: "typescript preferences",
  k: 5,
});

for (const memory of hits.results as Array<Record<string, unknown>>) {
  console.log(memory.summary);
}

await client.close();
```

### Authentication

Four ways to authenticate, in resolution order:

1. **Explicit key** — `new KaguraClient({ apiKey: "kagura_..." })`
2. **Environment** — `KAGURA_API_KEY` (+ optional `KAGURA_MCP_URL`)
3. **OAuth profile** — `~/.kagura/credentials.json`, written by `login()`
   (below) or the Python CLI's `kagura auth login`. Profiles
   (`KAGURA_PROFILE` env or `{ profile: "name" }`) and auto-refresh work
   exactly like the Python SDK; the credentials file is shared between both
   SDKs.
4. **Config file** — `.kagura.json` in the working directory or home:

```json
{
  "api_key": "kagura_your_api_key",
  "mcp_url": "https://memory.kagura-ai.com/mcp"
}
```

Credentials travel over HTTPS only. Every client, `login()`, `auth login
--server` and the URL every `setup` subcommand puts in a harness entry
(`setup claude`, `setup codex`, `setup hermes` and `setup openclaw`)
refuse a plain-HTTP URL unless its host is `localhost`, `127.0.0.1` or
`[::1]`, and `doctor` fails a configured `mcp_url` like that. The URL is
read as `fetch` reads it, so the scheme in any case (`HTTP://`), without
its slashes (`http:host`), or with whitespace or control characters
around it or a tab or newline inside it is refused all the same, as in
the Python SDK.

### Command line

`kagura-memory` mirrors the Python CLI's `kagura` command: its subcommands
and flags take the Python CLI's names, and it prints the same JSON on
stdout and exits with the same codes (2 for a usage error, 1 for a runtime
failure). An option a command, a group or the root does not take is
refused in the words of click 8.3, the version the Python CLI's lockfile
pins: `Error: No such option: --x`, naming the option without any value
given in it, and for a long option close to one the command takes,
click's suggestion after it (`Did you mean --json?`, or `(Possible
options: --end, --period)` for more than one); click 8.4 and later write
`No such option '--x'.`. An option given no value is `Error: Option '-w'
requires an argument.`. Either error wins over `--help`, as click reads
the whole command line first, and only the first one is reported,
followed by the command's help (where click prints its usage line and a
`Try '… --help'` hint first). An unknown option does not win over
`--help` where the Python CLI passes such options on
(`ignore_unknown_options`: `secret exec`, and `measure record` for a
negative VALUE), so `secret exec --help --bogus` prints the help; without
`--help`, `secret exec` still refuses an unknown option before the child
command rather than running it as that command. The one command not
ported, the few options only this bin has, and the deliberate
differences are listed below.

Values are read as click reads them. A choice matches exactly, as click's
`Choice` does, except where the Python CLI declares one case-insensitive
(`--source-type`, `--progress`), casefolded as click folds it; a number
is read as Python's `int()` and `float()` read it, `1_000`, any decimal
digit (`١٢`, `１２`) and the whitespace they skip included (a BOM is no
whitespace to them); an integer id argument (`TOKEN_ID`,
`INVITATION_ID`, `KEY_ID`) is sent exactly, however large; and an
out-of-range value is echoed as click converted it (`files upload
--importance 2` is refused as `2.0 is not in the range 0.0<=x<=1.0.`).
A failure prints `Error: <message>` on stderr, and a quota or plan
refusal adds the lines the Python CLI adds: `  Resets at: <time>`, in
Python's `isoformat()` form, and `  Required plan: <label> (<key>)`.

```bash
npx kagura-memory --help
```

| Group | Commands |
|---|---|
| `auth` | `login` `logout` `refresh` `status` `use` `list` `token` `create-key` `list-keys` `revoke-key` |
| `context` | `list` `create` `update` `delete` `search-config` (plus the `contexts` alias) |
| memory | `remember` `recall` `reference` `forget` `update-memory` `explore` |
| `edge` | `list` `create` `update` `delete` |
| `sleep` | `history` `report` `rollback` |
| `measure` | `record` `series` |
| `files` | `upload` `list` `delete` `download-url` |
| `guardrails` | `load` `digest` |
| `resource` | `tokens {list,create,update,revoke}` `list` `setup` `schema` `stats` `indexer-status` `events` `ingest` `ingest-batch` `import` |
| `secret` | `keygen` `list` `put` `get` `grant` `revoke` `rotate` `delete` `pubkeys` `approve` `audit-verify` `exec` |
| `setup` | `claude` `codex` `hermes` `openclaw` |
| `workspace` | `member {list,add,set-role,remove}` `invite {create,list,revoke}` |
| other | `config show` `doctor` |

```bash
npx kagura-memory auth login --profile work --read-only
npx kagura-memory recall "OAuth setup" -c dev -k 10
npx kagura-memory recall "dependency injection" --no-rerank   # skip reranking; no flag follows the context config (v0.69.0+)
npx kagura-memory remember -s "FastAPI DI" --content "Use Depends()" --tags "python,fastapi"
npx kagura-memory measure record <context-id> weight_kg 71.5 --unit kg
npx kagura-memory setup codex --dry-run   # show the command and the entry; change nothing
npx kagura-memory doctor
```

The context id comes from `-c/--context-id`, or from `context_id` in
`.kagura.json`. Credentials live in `~/.kagura/credentials.json` and are
shared with the Python CLI, so either tool can create a profile the other
then uses.

**`resource setup`** names the new context after the resource, or `-n/--name`
(lowercase letters, digits, `-` and `_`, at most 100), which a workspace
that already has a context of that name needs. It prints Python's six
fields, `context_id`, `context_name`, `resource_id`, `token`, `token_id`
and `warning` (null when the server sends none); the token is shown this
once. `--summary` is accepted and ignored, with a note on stderr, since
the server's `setup_resource` has no summary: the context's owner sets it
afterwards with `kagura-memory context update <context_id> --summary …`.
As in Python, `resource tokens revoke` prints `Token revoked.`, and
`resource schema` prints `No schema registered for this resource.` when
there is none (the route's 404).

**Records print as the Python CLI prints them.** `resource tokens
list|create|update`, `resource list|stats|indexer-status|events|schema`,
`resource ingest|ingest-batch|setup`, `files list` and `files upload`
print the result as the Python CLI does, `model_dump_json(indent=2)` of
the Python SDK's model
([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)):
the model's keys in its order, its default for a key the server left out
(`null`, `false`, `0`, `[]`, `{}`, `"success"`), and no key it does not
have. Each value is what the model's type makes of it: `"12"` for an int
prints `12`, a float prints as one (`1.0`, `1e-6`), a resource event's id
past 2^53 prints exactly, and a timestamp prints in pydantic's form
(`2026-06-01T09:00:00.5+00:00` as `2026-06-01T09:00:00.500000Z`), which
is the form memory-cloud already sends. A record the model refuses (a
required field missing, a value of the wrong type) exits 1 with the
Python SDK's `KaguraResponseError` text, e.g. `ResourceClient.list_tokens:
unexpected server response for PaginatedResourceTokensResponse
(tokens.0.created_at: Field required). …`, and so does a body that is no
record at all (`null`). An untyped mapping nested past pydantic's limit
(256 containers) exits 1 with pydantic's `Error serializing to JSON:
ValueError: Circular reference detected (depth exceeded)`. The body is
read as Python's `json.loads` reads it
([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)),
so an int field sent `9007199254740993` prints exactly, one sent `1e20`
exits 1 as pydantic refuses it (`Unable to parse input string as an
integer, exceeded maximum size`), and a float field sent `-0` prints
`0.0`. Inside an untyped mapping (an event's `payload`, a batch's
`errors`) the keys print in the server's order (`{"b": 1, "2": 2}` stays
so) and each number as Python read it (`1.0`, `1e+16`, `-0.0`, an
integer past 2^53 exactly). `NaN` and `Infinity` are read, and print
`null` as pydantic writes them; an integer of more than 4,300 digits
makes the body non-JSON, as Python's `int()` limit does; and a body
nested deeper than 973 containers exits 1 with Python's `maximum
recursion depth exceeded while decoding a JSON array from a unicode
string`. A string value holding a lone surrogate (`"\ud800"`) exits 1
with pydantic's `Error serializing to JSON: UnicodeEncodeError: 'utf-8'
codec can't encode character '\ud800' in position 0: surrogates not
allowed`; a key of the untyped mapping itself holding one prints as
three U+FFFD, as pydantic converts it, and a key of a mapping nested
inside it exits 1 like a value. Three differences remain. Python's depth is its recursion limit
less the stack in use: 973 is what these commands reach, and `doctor`
given such a `/api/v1/system/info` body reports a failed server check
where Python stops with a traceback. A body that is not valid UTF-8 is
read with U+FFFD in place of the bad bytes, where Python calls it
non-JSON. And only REST bodies are read this way: the MCP commands
(`recall`, `remember`, …) still print a whole float as `1` and list an
object's integer keys first.

**Files and imports.** The `files` commands take their workspace from the
credential's own source, as the Python CLI does (its #115): `-c` when
given, else the OAuth profile's workspace, else the `context_id` of the
`.kagura.json` that holds the key; a `KAGURA_API_KEY` key needs `-c`.
`files delete` prints `Deleted <file_id>` and `files download-url` the bare
URL. `files upload --remember` writes the memory the Python CLI writes
(`source_uri` the file's `file://` URI, `details` the file's id, sha256,
size and type), and prints `{"file": …, "memory": …}`, the file as its
model reads it. `resource import` detects the format by the file's
extension, so stdin needs `--format`, and reads CSV and JSON the way
Python's `csv` and `json` modules read them, with their error messages
(exit 1). A row keeps its keys in the order read, and a doc_id taken from
a number is Python's `str()` of it as written (`1234567890123456789`,
`10.0`, `1e+20`). A `NaN` or `Infinity` in the input fails the batch
holding it, as the Python CLI's request encoding does (`Out of range float
values are not JSON compliant: nan`), rather than being sent as `null`. A
doc_id outside 1-255 characters and a CSV row with more cells than the
header are refused before anything is sent, where the Python CLI stops
with a traceback. Two limits of JavaScript numbers remain: a number in the
payload is sent as JavaScript reads it, so an integer past 2^53 loses its
last digits and `10.0` is sent as `10`, where Python sends them as
written; and `-V` above 2^53 is refused as too large (exit 2), where
Python sends it. The summary prints as Python's `json.dumps` prints it
([#69](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/69)):
`created` and `failed` add up exactly past 2^53, and each error keeps
the server's key order and numbers (`1.0`, `1e+16`, `NaN`); a lone
surrogate in an error's string or key prints as `?` (one per code unit,
`"😀???x"`), as the Python CLI's UTF-8 stdout with `errors="replace"`
writes what `json.dumps` kept. The progress
events' counts (`-v`) are still JavaScript numbers, so past 2^53 they
are rounded where Python's are exact.

**Progress.** `files upload` and `resource import` take `-v/--verbose`
(repeatable) and `--progress rich|json|none`. Progress goes to stderr, one
line per event, so stdout carries the same result either way.
`--progress json` writes the Python CLI's NDJSON,
`{"v": 1, "ts": …, "stage": …, "kind": …, "msg": …, "detail": …}`, whose
last event is the operation's single `success` or `error`; `-v`, or
`--progress rich`, writes the lines the Python CLI shows
(`→ Reserving upload report.pdf (1234 bytes)`, `✓ Upload complete`,
`✗ Upload failed: …`); `--progress none` is silent even with `-v`. Two
streams end more reliably than Python's: `files upload --remember`
reports success only once the linked memory is written (a failed write
ends the stream with that error), and `resource import` ends with an
error when the credential fails after its start event. A stderr closed
early (`2>&1 | head -1`) does not stop the upload or the import. Ctrl-C
ends the process without a final event.

**Connecting a harness.** Each `setup` subcommand sets up an MCP entry
named `kagura-memory`: the URL plus a Bearer header. The key is never
printed, and no harness CLI gets it on its command line.

`setup claude` also writes `.kagura.json` (0600, gitignored). Its key
comes from `--api-key`, else the `api_key` in the project's own
`.kagura.json` (the one in `--project-dir`), else `KAGURA_API_KEY`; the
URL likewise from `--mcp-url`, else that file's `mcp_url`, else
`KAGURA_MCP_URL`, an empty `--mcp-url` counting as none, as Python's `or`
reads it. It never takes them from `~/.kagura.json`, nor, with
`--project-dir`, from the current directory's `.kagura.json`: those are
another project's credentials. `.kagura.json` gets the URL as given; the
parameters that `--guardrails` and `--tool-profile` set go on the entry's
URL only. A plain-HTTP URL to a host other than localhost is refused,
whichever of the three it came from, before anything is written or run
(exit 1, `Connection failed: MCP URL must use HTTPS for security …`, the
Python CLI's words, whose connection test refuses it).

Without `--agents-md`, `setup codex`, `setup hermes` and `setup openclaw`
never see, write, print or pass the key, as in the Python CLI. The entry
names the environment variable the harness reads the key from, and the
notes say where to put it; a missing key is no error. These three write
no config file themselves: no `.kagura.json`, no `.gitignore` line, no
harness `.env`. The harness's own CLI writes the entry, or you add the
printed block. The one file they may write is the AGENTS.md export
(`--agents-md`, below), which is fetched with the usual credential: with
it, a missing credential stops setup (exit 1).

| Subcommand | How the entry is applied | Where the key goes |
|---|---|---|
| `setup claude` | `.mcp.json` (`--scope project`, the default), or `claude mcp add-json --scope user …` | `--scope project`: in `.mcp.json`; `--scope user`: `KAGURA_MCP_API_KEY`, exported where Claude Code starts |
| `setup codex` | `codex mcp add … --bearer-token-env-var KAGURA_API_KEY` | `export KAGURA_API_KEY=…` in the shell profile that starts Codex |
| `setup hermes` | the `config.yaml` block is printed; `hermes mcp add` is interactive, and this port never prompts | `MCP_KAGURA_MEMORY_API_KEY=…` (`MCP_<NAME>_API_KEY` with `--name`) in the `.env` beside `config.yaml`, added with an editor |
| `setup openclaw` | `openclaw mcp add … --transport streamable-http --no-probe`, or `openclaw mcp set` to replace an entry | `KAGURA_API_KEY=…` in `$OPENCLAW_STATE_DIR/.env` (default `~/.openclaw/.env`), added with an editor |

`--api-key-env VAR` renames `KAGURA_API_KEY` for Codex and OpenClaw
(an upper-case letter or `_`, then upper-case letters, digits or `_`).
Hermes names its variable itself, so `setup hermes` refuses the option
(exit 2). The entry goes into Codex's `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`), into Hermes's `config.yaml` in `$HERMES_HOME` or
else the active Hermes profile's directory (`~/.hermes/profiles/<name>`
when `~/.hermes/active_profile` names one, else `~/.hermes`), or into
OpenClaw's `$OPENCLAW_CONFIG_PATH` (default `openclaw.json` in the state
directory). The closing notes name the command that checks it:
`codex mcp get kagura-memory`, `hermes mcp test kagura-memory` or
`openclaw mcp doctor kagura-memory --probe`. `--mcp-url` defaults to the
configured `mcp_url`, then `https://memory.kagura-ai.com/mcp`. It is read
as a URL parser reads it, as in Python (python-sdk#279): whitespace and
control characters around it, and any tab or newline inside it, are
dropped before the checks, and the entry gets that URL. A plain `http://`
`--mcp-url` other than localhost, in any spelling, is a usage error
(exit 2), since the entry sends the key there with every request; so is
anything but an http(s) URL with a host (`--mcp-url=--help`,
`memory.kagura-ai.com/mcp`, `https://[::1/mcp`), which would go on the
harness's command line after `--url`. A configured `mcp_url` gets the same
checks, and exits 1 saying to pass `--mcp-url`. `$OPENCLAW_STATE_DIR`,
`$OPENCLAW_CONFIG_PATH` and `$OPENCLAW_WORKSPACE_DIR` are read as OpenClaw
reads them: stripped, with a leading `~` expanded.

This package has no TOML, YAML or JSON5 parser, so it never rewrites those
files. When the harness's CLI is not on `PATH`, the block is printed on
stderr with the file it belongs in, and stdout stays one JSON document.
When Hermes's `config.yaml` already has an `mcp_servers:` key, only the
`kagura-memory` entry is printed, to go under it: a second top-level
`mcp_servers:` would replace the first, and every server in it. An entry
of the same name, which setup finds by scanning the file, stops the run
(exit 1, nothing changed) unless you pass `--force`. For Codex that holds
always; for Hermes and OpenClaw only with their CLI on `PATH`, since the
Python CLI finds their entries only through it. Without the CLI, setup
prints the block to go in place of the old entry and exits 0. A
`config.toml` that cannot be read stops `setup codex` (exit 1), as in
Python. A Hermes `config.yaml` that cannot be read, or is not UTF-8,
stops nothing: setup prints the whole block with Python's note to put
only the entry under an `mcp_servers:` key the file may have. An OpenClaw
file that cannot be read stops nothing either, since Python never reads
it, and a note says setup could not look there.
On Windows, a CLI installed only as an npm `.cmd` shim counts as not
found: Node runs one only through a shell, which would re-parse the
arguments.

With `--scope user`, the Claude Code entry does not hold the key: it
sends `Authorization: Bearer ${KAGURA_MCP_API_KEY}`, which Claude Code
fills in from its own environment each time it connects. The key is never
on the `claude mcp add-json` command line, where any local user could read
it in the process list, and never in `~/.claude.json`. Set the variable in
the environment that starts Claude Code, e.g. `export
KAGURA_MCP_API_KEY=kagura_xxx` in your shell profile; setup says whether
the current shell has it, and `doctor` warns when it is unset. It is a
separate variable from `KAGURA_API_KEY`, which the SDK ranks above
`.kagura.json` and OAuth profiles for every command. The entry is the one
the Python CLI writes, so a run of either CLI finds the other's entry up
to date. `--scope project` still writes the key into `.mcp.json`, so keep
that file out of version control (setup adds it to `.gitignore`). A
user-scope entry this CLI wrote before 0.11.0 still holds the key in
`~/.claude.json`: re-run `setup claude --scope user` with
`KAGURA_MCP_API_KEY` exported to replace it (`doctor` warns about one).

`--guardrails <context-id|off>` (memory-cloud v0.74.0+) sets the URL's
`guardrails` parameter on `setup claude` and `setup codex`. On `setup
codex`, when neither the flag nor the MCP URL (`--mcp-url` or the
configured `mcp_url`) sets one, it defaults to `off` while the Kagura
plugin's Codex hooks are on for the entry (their `config.json` names its
table in `mcp_server`, `kagura-memory` by default), and otherwise to
`-c`. With a context there, the notes give the `kagura-memory guardrails
digest … --target instructions` command, which previews what Codex
receives. Hermes and OpenClaw do not read the server's instructions.
There `--guardrails off` is refused (exit 2), and a context id is not
written, whether it comes from the flag or from the URL: one warning
names what was dropped. A first `?guardrails=off` in the URL, the value
the server reads, is kept, alone and with a warning of its own. Names
compare decoded, as the server reads them (`guard%72ails` is
`guardrails`). All of this is as in Python. `--tool-profile` (claude,
codex; memory-cloud v0.73.0+) sets `profile` and refuses an empty name.
The server knows
`full` and `core` (case-sensitive) and fails `tools/list` for any other
name, which leaves the harness with no Kagura tools. It applies a
`?tools=` allowlist already on the URL instead, so that case gets a
warning. Both go at the end of the query, `guardrails`
first, replacing any value already there, as the Python CLI writes them.
A `setup claude` run that leaves out a `guardrails` or `profile` value
the entry it replaces had says so in a note. `--name`, `--force` and
`--dry-run` (codex, hermes, openclaw) name the entry, replace an existing
one, and show the command or block without changing anything. A name is
1-64 letters, digits, `-` or `_`, starting with a letter or digit, as in
Python: it is a bare argument to `codex` and `openclaw`, which would read
`--help` as an option. Their `--context-id` must be a context UUID
(exit 2 otherwise, a padded or empty one included), as in Python without
`--profile`: this port lists no contexts.

**The AGENTS.md export.** `--agents-md [PATH]` on `setup codex`, `setup
hermes` and `setup openclaw` (memory-cloud v0.74.0+) fetches the
context's tool guardrail export block (`MemoryClient.getGuardrailDigest`)
and splices it into a file the harness loads every session, between its
`kagura-memory:guardrails` marker lines: an earlier block is replaced in
place, an unchanged set rewrites nothing, and the rest of the file is
kept, line endings and a symlink included. Without PATH the file is the
harness's own: `$CODEX_HOME/AGENTS.md` (`AGENTS.override.md` when that
exists); for Hermes the first of `.hermes.md`, `HERMES.md`,
`AGENTS.override.md`, `AGENTS.md` and `CLAUDE.md` in the current
directory, else `AGENTS.md`; for OpenClaw `AGENTS.md` in its workspace,
`$OPENCLAW_WORKSPACE_DIR`, else `workspace/` in the state directory. A
leading `~` or `~/` in PATH is expanded to your home directory (a
`~user` is left as written; see below), and missing directories are
created. The context is `--context-id`, else a `--guardrails` context
UUID, never the
URL's `?guardrails=` or `.kagura.json`; without one, `--agents-md` is a
usage error (exit 2). The block is fetched on the usual credential chain
(`KAGURA_API_KEY`, the OAuth profile, `.kagura.json`), which setup
settles before it runs anything, a dry run included: no credential, or
one for another server than the entry's, stops setup (exit 1) with
nothing run. The export comes after the entry is applied or printed.
`wrote` lists the file, and the notes carry Python's lines: the refresh
command (`kagura-memory guardrails digest <ctx> --out <file>`), a warning
past the 32 KiB Codex reads or the 20,000 characters OpenClaw reads, and
Hermes's prompt-injection note. An empty digest writes nothing and says
so; setup never removes a block, which `guardrails digest --out` does. A
failed export prints the report, then the error (exit 1). `--dry-run`
names what the export would do to the file (create it, append the block,
replace the block, or update a file it cannot read). On Hermes and
OpenClaw a run without the export ends with Python's "Re-run with
--agents-md --context-id <id> …" hint.

Claude Code uses the `kagura-memory` entry from the strongest scope
(local > project > user). It keys local scope by the git repository root
(a linked worktree's main working tree), and takes project scope from the
closest `.mcp.json` that defines the entry, in the directory it runs in or
any parent; `setup claude` and `doctor` read them the same way.
`setup claude` writes nothing when a stronger scope already defines one,
and prints the `claude mcp remove --scope …` command for it, after a `cd`
into the directory that command must run in when that is not the current
one. An entry the new one hides, in a weaker scope or in a parent's
`.mcp.json`, is noted. Messages name `~/.claude.json` by the file actually
read: `$CLAUDE_CONFIG_DIR/.claude.json` when that is set.
With `--scope user`, an identical user-scope entry is left as it is and a
different one is replaced: `claude mcp remove` runs before `claude mcp
add-json`, and if the add then fails, the old entry is put back. An old
entry that holds a key (as this CLI wrote before 0.11.0) is never put
back, since that would pass the key on a command line; when it is not put
back, or putting it back fails, setup prints the command that re-adds it,
the key masked as `<your-api-key>`.
Without `claude` on `PATH`, `--scope user` prints the commands to run, and
where to set `KAGURA_MCP_API_KEY`, and writes nothing, unless the
user-scope entry is already identical. When `claude plugin list --json`
shows the Kagura Memory plugin enabled, the notes list the plugin settings
to enter, and say that the plugin has one guardrail context for every
project and authenticates only with a user API key. `setup claude` writes
`.kagura.json` and the MCP entry only; it installs none of the Python
CLI's hooks or `/kagura-recall` and `/kagura-remember` commands. Their
flags (`--[no-]session-hook`, `--[no-]sync-hook`, `--[no-]commands`) and
`--no-auto-context` are accepted, so a script written for the Python CLI
still runs, and change nothing. `doctor` reports the entry Claude Code
uses in the current directory, with its scope and file, and warns about
each entry that one hides. It also warns when a header of that entry
sends a `${VAR}` that is unset in the current environment, or when that
entry is in user or local scope and holds the key itself, in
`~/.claude.json`, saying how to replace it; and for a
`kagura-mcp` stdio entry (the Python CLI's `--profile` form) checks that
`kagura-mcp` is on `PATH`. For a `type: "url"` entry, which earlier
releases wrote and Claude Code skips, it names the fix for the entry's
scope.

**Not ported.** `kagura ingest` needs the text-extraction pipeline (PDF,
Office, EPUB, audio), which does not exist in this package and would cost
the zero-dependency promise; use the Python CLI for it. The Claude Code
extras of `kagura setup claude` are not ported either: its SessionStart
and PostToolUse hooks and its `/kagura-recall` and `/kagura-remember`
commands. `setup claude` here writes `.kagura.json` and the MCP entry
only, and takes their flags as inert (see above). Every other command of
the Python CLI is here as of 0.12.0
([#57](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/57)),
with the differences in options and output this section lists.

**Only in this bin.** `secret keygen --reveal`: keygen prints the private
key (see key custody below) and refuses to print it to a terminal without
`--reveal`. `-c` is short for `--context-id` on every `setup` subcommand.
`setup codex` also takes `--tool-profile`, which the Python CLI has only on
`setup claude`. `auth refresh --no-browser`: a refresh that widens
`--scope` re-runs the device flow here too, and this skips opening the
browser, as on `auth login`; Python's `auth refresh` takes only
`--profile` and `--scope`. `-h` is short for `--help` everywhere, where
the Python CLI takes only `--help`. `setup codex`, `setup hermes` and
`setup openclaw` still
accept `--api-key` and `--project-dir`, which they took before 0.11.0, so
older scripts still run. Neither does anything now, and a note says so.
`--api-key` beside `--profile` is still the usage error (exit 2) it was,
with `--url-form` too.

**Five deliberate divergences.**

- `secret` needs the optional `age-encryption` peer (`npm install
  age-encryption`), exactly as Python's `[secret]` extra works. Key
  custody differs: Python uses the OS keychain via `keyring`, which has no
  zero-dependency equivalent in Node, so this CLI reads the age identity
  from `KAGURA_AGE_IDENTITY` or `KAGURA_AGE_IDENTITY_FILE` and fails
  closed when neither is set. **A key custodied by the Python CLI is not
  readable here, and vice versa.**
- `setup … --profile` (the OAuth path) writes an entry that launches
  Python's `kagura-mcp` stdio proxy, which this package does not install.
  Every `setup` subcommand reports the fact, and names the Python CLI's
  `kagura setup <harness> --profile` command, instead of writing a config
  that would fail at launch. The `--api-key` path of `setup claude` works
  here, and so does the URL form of the other three. With `--url-form`,
  those three ignore `--profile`, with a note: the Python CLI uses it
  there to check the login, list contexts and fetch the `AGENTS.md`
  export with that profile alone. This port lists nothing and checks no
  login, and fetches the export on the usual credential chain, where
  `KAGURA_PROFILE` picks a profile.
- `config show` does not reproduce Python's key mask
  (`key[:8] + "..." + key[-4:]`), whose halves overlap below 12 characters
  and print the whole secret twice.
- `--progress rich`, and `-v` without `--progress`, print the Python CLI's
  `→` / `✓` / `✗` lines as plain text, the text Rich writes when stderr is
  not a terminal: no colours even on a terminal, no wrapping at its width,
  and no Rich markup, so `report[bold].pdf` prints as written (Rich drops
  the `[bold]`, and a `[/…]` in an error message makes it fail). `-vv` and
  `-vvv` show one line per detail or debug event, where Rich draws a panel;
  neither command emits one. `--progress json` is the same NDJSON.
- With no `.kagura.json`, the MCP-backed commands (`recall`, `guardrails
  load`, `measure`, …) and `doctor` reach an OAuth profile's own server.
  The Python CLI takes the default URL its config loader fills in for the
  server, and sends the profile's token there. A `KAGURA_API_KEY` goes to
  `KAGURA_MCP_URL`, else the default, in both.

**`setup codex`, `setup hermes` and `setup openclaw`** also differ from
the Python CLI in these ways, each on purpose:

- Every entry here is the URL form, so `--url-form` is accepted and
  changes nothing, and `--mcp-url` falls back to the configured URL where
  Python requires it. Only that fallback needs the configuration: without
  `--mcp-url`, a `.kagura.json` that cannot be loaded stops setup (exit 1);
  with it, setup goes on with a note, as Python never reads that file.
- `-c` must be a context UUID with `--url-form --profile` too (exit 2),
  where Python looks a name up through the profile.
- `setup hermes` never runs `hermes mcp add`, which prompts; it prints the
  block, as Python does under `-y`.
- An existing entry is found by scanning the file, and not described by
  kind. A readable but malformed `config.toml` does not stop
  `setup codex`.
- On Codex, a `?guardrails=` already in the MCP URL (`--mcp-url` or the
  configured `mcp_url`) beats the hooks and `-c` defaults.
- Nothing prompts, so `--agents-md` always needs a context, and the
  export is never offered: a dry run of Hermes or OpenClaw says "not
  offered: this port never prompts" (or "not offered with -y").
- When the entry was only printed (always for Hermes), a failed export
  says "The MCP entry is printed for you to add", where Python says it is
  set up. When the export credential is for another server, the message
  says what moves it here, where Python's points at `--profile`: for
  `KAGURA_API_KEY`, which outranks every profile, `KAGURA_MCP_URL` or
  unsetting the key; otherwise `KAGURA_PROFILE`.
- `--agents-md=VALUE` takes VALUE literally even when it begins with a
  dash, where click reads `--agents-md=-y` as the default file plus `-y`.
- The Codex size warning counts the bytes on disk, CRLFs included, where
  Python counts the text with its line endings folded.
- A `~user` in an `OPENCLAW_*` variable or in `--agents-md PATH` is left
  as written (`--agents-md '~root/x.md'` names `~root/x.md` in the
  current directory), where Python looks the user up (`/root/x.md`) and
  fails the whole setup for an unknown one. File errors of the export are
  Node's words, not Python's `[Errno …]`.
- Output is one JSON document on stdout, with Python's sentences in
  `notes` and the block on stderr. A non-ASCII URL is written as UTF-8
  where Python writes `\uXXXX` escapes; both are valid.

Some small divergences run the other way: this CLI refuses what click
would accept.

- `--profile=` and `--scope=` reject an explicitly empty value. An empty
  profile name would create a nameless profile and an empty scope would go
  to the server verbatim. Other options take `--flag=` as Python does,
  apart from `--external-id=` in the `update-memory` case below.
- `context update --lock --unlock` is a usage error (exit 2, "mutually
  exclusive; pick one"), where click takes whichever flag comes last.
- `setup … --agents-md=' '` (a path of only whitespace) is a usage error
  (exit 2), where Python writes a file named `" "`.
- `--rerank --no-rerank` is the same usage error, on `recall` and on
  `context search-config`.
- `auth logout --all --profile NAME` is the same usage error, where click
  ignores `--profile` and logs out every profile.
- `update-memory --dismiss-supersede-candidate` exits 1 beside any
  `--external-id`, before anything is sent. The Python CLI refuses only a
  non-empty one, and sends an empty `--external-id=` to the server; this
  CLI refuses that too, as `updateMemory` does.
- `-k=5` (a short option, `=`, a value) reads `5`, where click reads `=5`
  as the value and then refuses it.
- A float range such as `files upload --importance` refuses `nan`, which
  click's `FloatRange` lets through (every comparison with NaN is false).
- An option that takes a value does not take a following argument that
  begins with a dash and is not a number (a lone `-` is still a value):
  `--name-contains -auth` is a missing value here (`Error: Option
  '--name-contains' requires an argument.`), where click takes `-auth`.
  Write `--name-contains=-auth`. A number is anything `float()` reads,
  so `-١` is one. `auth login --invite` is the exception, since an invite
  token may begin with a dash.
- `guardrails digest --out ''` is a usage error (exit 2). Click takes the
  empty path as the current directory, and the Python CLI then fails to
  write to it (exit 1).
- An id the command puts in a URL path, `FILE_ID` (`files delete`, `files
  download-url`), the resource id (`-r/--resource-id` of `resource stats`,
  `indexer-status`, `schema`, `ingest`, `ingest-batch` and `import`, and
  `resource events RESOURCE_ID`) and `USER_ID` / `--user`, is refused when
  it is `.`, `..` or empty (exit 2, `Invalid value for 'FILE_ID': '..' is
  not a valid file id.`), before anything is read or sent. The Python CLI
  sends it, and URL resolution then drops or climbs the segment: `files
  download-url ..` asks for `/api/v1/download-url`. (From 0.41.1 it
  refuses a `USER_ID` as this bin does.) Any other id is sent
  percent-encoded as one segment, so a `/`, `?` or `#` in it stays in the
  id rather than reaching another route or replacing the query
  (`files delete 'x?workspace_id=…'`).

**`guardrails load` and `guardrails digest`** (memory-cloud v0.74.0+)
take the context as an optional argument, else `context_id` from
`.kagura.json`. `load` calls the MCP `load_guardrails` tool and prints the
set as the Python CLI prints it: the model's fifteen keys in its order,
without the `context_display_name`, `context_is_private` and
`context_is_locked` the tool adds, each item's eleven keys, and `null` for
a `tool_trigger` the Python SDK cannot read (`match: null` is filled in
when a trigger has none). A set missing a required field, a truncation
flag above all, is refused with the Python SDK's `KaguraResponseError`
text (exit 1) rather than printed as complete. `--cap` takes 1-1000.
`digest` reads the REST digest route with the credential chain (an API
key or an OAuth profile) and prints the text: the `AGENTS.md` export
block, or with `--target instructions` the MCP server instructions this
credential would receive, where `--profile` and `--tools` repeat an MCP
URL's `?profile=` and `?tools=`. A context with no tool guardrails prints
nothing, and says so on stderr. With `--out FILE`, it splices the block
into FILE between its marker lines: an earlier block is replaced in place,
an unchanged set rewrites nothing, and an empty set removes an earlier
block. It then prints one JSON line, `{"path": …, "status":
"written"|"unchanged"|"removed", "tool_triggered_version": …}`, with the
path as Python's `pathlib` writes it (`./x/../X.md` reads `x/../X.md`).
As in Python, `--out` does not expand `~`, never creates a missing parent
directory, and keeps a symlink, the file's mode and its line endings.
Beside JSON's `1` for Python's `1.0` (an `importance`), two differences
remain: an item's `created_at` / `updated_at` is printed as
the server sent it, where Python reformats it and refuses one it cannot
parse; and a failed read or write of the `--out` file reads in Node's
words (`ENOENT: no such file or directory, open '…'`) rather than
Python's (`[Errno 2] No such file or directory: '…'`).

**`doctor`** checks the credentials, the `kagura-memory` entry Claude Code
uses, the optional `age-encryption` peer and the age identity, then the
server, whose checks are the Python CLI's: `Server reachable`, then
`Version: <version>` by the same comparison `checkServerVersion` makes
([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)).
The version passes at or above `MIN_SERVER_VERSION` (0.75.0), fails below
it (`Version: 0.74.0 is below minimum 0.75.0`, a pre-release of 0.75.0
included) and is `info` when it cannot be compared (`main-abc123`, `0.78`).
An unreachable server fails with `Server unreachable: …`, and an OAuth
profile the REST route refuses is `info`, in Python's words. The
`/system/info` body is read through Python's `ServerInfo` model, and one
it refuses (no `name`, a `version` that is no string) fails as
unreachable: `Server unreachable: Invalid response format: …`, naming the
problem in the SDK's words where Python prints pydantic's. A credential
that does not resolve fails the auth section with Python's
`Authentication could not be resolved: …` and skips the server check
(`info`), as in Python. With
`--profile NAME` the server is checked with that profile, as in Python
(`KAGURA_API_KEY` still comes first), not with the default. `--json`
prints Python's shape, with `details` on every check (`{}` when there are
none). Any failed check exits 1.

**Sign-in rate limit.** memory-cloud v0.76.0 and later limit device sign-in
requests per client address. When the server refuses one with HTTP 429,
`auth login` says so and how many seconds to wait (from the `Retry-After`
header, 60 when it is missing or not a number of seconds), with the
server's reason, when it gives one, on the next line.
`login()` and `authorizeDevice` throw the same message as a
`KaguraAuthError`.

**`auth` subcommands.** Each takes only the options it reads, as in the
Python CLI: any other is refused with click's `Error: No such option: --x`
(exit 2), except `--invite`, which every subcommand but `login` refuses
with `--invite applies only to 'auth login'.` (exit 2, where click says
`No such option: --invite`), with a value or without and before
`--help`, as click's error would be, so that a token beginning with a
dash is not read as options. `--help` lists only a subcommand's own
options. `auth status` ends with the `kagura-memory` entry Claude Code uses in the
current directory and each entry it hides, in the Python CLI's words
(nothing when no scope defines one). `auth list --json` emits Python's fields per profile (`profile`,
`default`, `user_email`, `workspace_name`, `workspace_id`, `server`,
`scope`, `expired`, `refreshable`, `expires_at`), never a token, and `[]`
when there is none, with non-ASCII escaped as `\uXXXX`, as Python's
`json.dumps` default writes it. `auth list` and `auth status` without
profiles exit 1. `auth logout`
revokes the access
token on the server before it deletes the profile, best effort: the
profile is deleted even when that fails, with Python's warning (with
`--all`, silently, as in Python). It notes when `KAGURA_API_KEY` is still
set. Unlike the Python CLI, it asks before removing anything unless
`--yes` (`-y`) is given, rather than refusing `--all` without it; a
logout that names no profile succeeds when nothing is stored, so
`logout --yes` stays idempotent in setup scripts; and `--all` with
`--profile` is a usage error (exit 2), where Python ignores `--profile`
and removes every profile. `auth login` with both `--read-only` and
`--scope` exits 1, as Python does. `auth use NAME` prints Python's line,
`Default profile set to '<name>' (workspace '<workspace>').`, and a note
when `KAGURA_PROFILE` is set and still overrides the new default; an
unknown name exits 1 and lists the stored profiles, and a missing or
extra argument is a usage error (exit 2).

**`workspace` and the `auth` key commands** (memory-cloud v0.42.0+)
manage a workspace's members, invitations and member API keys:
`workspace member list|add|set-role|remove`, `workspace invite
create|list|revoke`, and `auth create-key|list-keys|revoke-key`, which
mint, list and revoke a key for another member. The server takes only
the workspace owner's static API key here; an OAuth profile gets an
access-denied error that says so. As in the Python CLI, the workspace
comes from the same source as the key
([#115](https://github.com/kagura-ai/kagura-memory-python-sdk/issues/115)):
`-w/--workspace` when given, else the OAuth profile's workspace, else
`context_id` in the `.kagura.json` that holds the key. A `KAGURA_API_KEY`
key needs `-w`, since nothing binds it to a workspace:
`KAGURA_API_KEY=<owner key> kagura-memory workspace member list -w
<workspace-uuid>`. An empty or `auto` `-w` is refused (exit 1) rather
than falling back to the source's workspace. `member remove` and `auth
revoke-key` ask first, naming the workspace, unless `--yes` (`-y`).
`create-key` prints the key, and `invite create` the invitation URL,
once on stdout, after a warning on stderr. `list-keys` and `invite list`
never show either; their `--json`, like `member list --json`, prints
the Python model's fields in its order, `null` or `false` for what the
server left out, and drops any other. A record the model refuses (a
required field missing, a scalar, list or mapping of the wrong type)
exits 1 with its `KaguraResponseError` text; timestamps are printed as
the server wrote them. `--role` matches exactly, as
click's `Choice` does (`Admin` is refused). Four things differ from the
Python CLI, each on purpose: a workspace that is not a UUID is refused
before `member remove` or `revoke-key` asks, where Python asks first;
each `invite create -c` must be a context UUID (exit 1, `context_id must
be a UUID, got '…'`), where Python sends it as typed and the server
answers `HTTP 500`; a user id of `.`, `..` or nothing (`USER_ID` or
`--user`) is refused (exit 2) before anything is asked or sent, where
Python sends it and URL resolution turns `member remove ..` into a
`DELETE` of the workspace's own URL; and an invitation with no email prints `-`, as
`invite list` does, where Python prints `None`.

**`measure record` and `measure series`** take the context as their
first argument, never from `.kagura.json`: an observation recorded in the
wrong context cannot be deleted. As in the Python CLI, a negative VALUE
needs no `--` (`measure record <context-id> pnl_usd -120`). The price is
that `record` reads any option it does not declare as an argument: after
VALUE it is an extra argument, and in the CONTEXT_ID or METRIC slot it is
refused as `No such option: <token>`, even after `--`, as the Python CLI
refuses it. These errors name a `--name=value` token `--name`, as every
other command does, where click prints the whole token: the value may be
a key. `--period` and `--agg` match exactly (`Week` is refused).
When both are bad, the error names `--period`, where click names
whichever comes first. The result prints as the Python CLI prints the
model: its keys in its order, and `unit` `null` when there is none. A
whole-number float prints without its `.0` (`72` for `72.0`).

#### Signing up with an invite

On a deployment that admits new accounts only by beta invite, pass the
invite to `auth login`, either as the bare token or as the
`https://…/join/<token>` link it arrived in:

```bash
npx kagura-memory auth login --invite <link-or-token>
```

Without it, a new user who starts from `auth login` is refused at sign-up:
the approval page sends a signed-out visitor to the login page, which does
not carry an invite. With it, once the device code is issued, the CLI asks
the server how to present the invite (`GET /api/v1/system/info`, which
takes no credentials, allowed 5 seconds):

- **The server supports the hand-off** (memory-cloud 0.76.0 or later,
  `v0.76.0` and build suffixes included; a pre-release of 0.76.0 such as
  `0.76.0-rc1` comes before it, as in the Python CLI): one link,
  `<frontend>/join/<token>?return_to=%2Fdevice%3Fuser_code%3D<code>`, that
  signs up with the invite and lands on the approval page with the code
  filled in. The browser opens that link. Below it, "If you land on the
  dashboard instead, approve here:" and the approval URL cover a user who
  is already signed in.
- **An older or unrecognised version, or the check failed**: two steps, in
  order. The plain `/join/<token>` link, which the browser opens, then the
  approval URL, and how long the code stays valid.
- **The server does not take invites** (a `features` object without
  `beta_invites: true`: invites are turned off, or the server is older than
  memory-cloud 0.70.0, which has no `/join`): a one-line note, then the
  ordinary prompt. A body
  with no `features` object says nothing about invites, so the version
  decides.

`<frontend>` is the device response's approval URL with its final
`/device` removed, so a frontend under a base path gets its `/join` beside
its `/device`. When that URL does not end in `/device`, the CLI does not
guess where `/join` lives: it takes the two steps, with your own link as
step 1, or tells you to open the invite you were sent when you gave a bare
token. It takes the two steps too when memory-cloud's `/join` would drop
the `return_to` (a path starting with `//`, as a frontend URL configured
with a trailing slash produces, or one holding a backslash or a control
character), which would otherwise leave the new user on the dashboard.

The invite is checked before any request. A malformed one exits 2 with
`Error: Invalid value for '--invite': <reason>`, the Python CLI's reason,
which never quotes the value. A pasted link must be written out in full,
`https://<host>/…/join/<token>` (a browser would repair `https:/host/…`;
the CLI does not), and must be HTTPS, as `--server` must (plain HTTP only
on localhost). A `/join` link is never built on a plain-HTTP frontend: the
token would travel in the clear. A link for a different server than the one
being logged into aborts before the server is asked about invites and
before the device code is polled, so no profile is written; the error
suggests logging in with `--server` instead. The token is never saved, in
`credentials.json` or anywhere else, and never appears in an error message:
it is printed only inside a link. Every other `auth` subcommand rejects
`--invite` with exit 2 rather than ignoring it. `--no-browser` works as it
does without an invite, and when the browser cannot be opened the CLI says
which link above to open by hand.

#### Logging in from TypeScript

`login()` runs the OAuth 2.0 Device Authorization Grant (RFC 8628) and
writes `~/.kagura/credentials.json` in exactly the format the Python CLI
writes — no Python install needed, and the profile stays interchangeable
between both SDKs.

```ts
import { login, KaguraClient } from "kagura-memory";

const creds = await login({
  onUserCode: ({ userCode, verificationUri, verificationUriComplete }) => {
    console.log(`Open ${verificationUri} and enter ${userCode}`);
    // Or, in a desktop app: shell.openExternal(verificationUriComplete)
  },
});

console.log(`Logged in as ${creds.userEmail} (${creds.workspaceName})`);

// Subsequent clients pick the profile up automatically.
const client = new KaguraClient();
```

There is no terminal IO and no browser launching inside the SDK —
`onUserCode` hands the code back and the host app decides how to show it.

Scope defaults to `DEFAULT_SCOPE` (`"memory:read memory:write"`) — the same
default as the CLI's `kagura auth login`, and exactly what the server's
pre-registered `kagura-cli` client is seeded with. Pass
`scope: READ_ONLY_SCOPE` for the CLI's `--read-only` behaviour. The two SDKs
share the credentials file, so a profile should not end up with different
authority depending on which one created it.

The server is resolved as `mcpUrl` > `KAGURA_MCP_URL` > the public default,
matching the CLI's `--server` chain — so a self-hosted deployment is picked
up from the environment. Plain HTTP is rejected for non-loopback hosts: the
flow carries a bearer token.

Nothing is written unless the exchange succeeds, so a failed login never
disturbs an existing profile: a denial throws `KaguraAuthDeniedError` and an
unapproved expiry throws `KaguraAuthExpiredError`. A response with no
`refresh_token` warns and still persists — the Python CLI treats a
non-refreshable profile as a valid degraded state, and the shared file must
mean the same thing to both SDKs. Check the returned `refreshToken` if you
need to react.

For a custom flow (your own polling UI, multi-profile management), the
primitives are exported too: `authorizeDevice`, `pollForToken`,
`refreshAccessToken`, `revokeToken`, plus the credentials store
(`loadCredentialsFile`, `updateProfile`, `setDefaultProfile`,
`deleteProfile`, …).

For a new user holding a beta invite, `buildInviteLink` builds the same
sign-up-and-approve link the CLI's `--invite` prints. It takes the Python
SDK's `build_invite_link` arguments in the same order: the two approval
URLs from the device response, then the invite token. `onUserCode` is the
first point where both are known, so call it there. It is a pure function
and does not check the server version; that check is the CLI's own.

```ts
import { buildInviteLink, login } from "kagura-memory";

const token = "<token>"; // the last path segment of https://…/join/<token>

await login({
  onUserCode: ({ verificationUri, verificationUriComplete }) => {
    // null when /join cannot be placed: the approval URL does not end in
    // /device, is plain HTTP off localhost, or is not a return_to that
    // memory-cloud's /join keeps.
    const link = buildInviteLink(verificationUri, verificationUriComplete, token);
    if (link !== null) console.log(`Sign up and approve: ${link}`);
    // A signed-in user, or a server older than memory-cloud 0.76.0, ends
    // up on the dashboard instead; the pending code is approved here.
    console.log(`Or approve at: ${verificationUriComplete}`);
  },
});
```

A malformed token throws `KaguraAuthError`, whose message never quotes it.

#### Refreshing

Clients auto-refresh as tokens near expiry, so most code never calls this.
`refresh()` covers what skew-driven rotation cannot:

```ts
import { refresh, READ_ONLY_SCOPE } from "kagura-memory";

// Forced rotation — e.g. after an upstream 401, when the token was
// revoked out-of-band and is not yet inside the skew window.
await refresh();

// Narrow an existing grant, no re-consent needed.
await refresh({ scope: READ_ONLY_SCOPE });

// Widening needs fresh consent, so it re-runs the device flow.
await refresh({
  scope: "memory:read memory:write profile:read",
  onUserCode: ({ userCode, verificationUri }) =>
    console.log(`Open ${verificationUri} and enter ${userCode}`),
});
```

The stored refresh token, scope, and workspace identity are preserved when
the server omits them. An expired refresh token throws
`KaguraAuthExpiredError` and leaves the stored profile untouched.

Callers holding their own provider can use `KaguraOAuth` directly — its
`forceRefresh()` is what `refresh()` builds on, including the
cross-process lock and the "another process already rotated" dedup.

### Error handling

All errors extend `KaguraError`:

```ts
import { KaguraNotFoundError, KaguraRateLimitError } from "kagura-memory";

try {
  await client.recall({ contextId, query: "..." });
} catch (e) {
  if (e instanceof KaguraNotFoundError) {
    // context or memory missing
  } else if (e instanceof KaguraRateLimitError) {
    console.log(`retry after ${e.retryAfter}s`);
  }
}
```

Server-side domain errors (`{"status": "error", ...}`) are translated into
exceptions, so you never need to inspect `result.status`. The class is
keyed on the error code and the envelope's fields, never on the message:

| Class | Raised for | Carries |
|-------|------------|---------|
| `KaguraNotFoundError` | missing contexts/memories/reports/agents/bindings (on `updateSearchConfig`, a missing context is a `KaguraPermissionError` instead) | — |
| `KaguraFeatureNotAvailableError` | MCP `plan_required` / `feature_not_available`; REST 403 `FEAT-001` — the plan lacks a feature, or it is switched off | `feature`, `requiredPlan`, `requiredPlanDisplay`, `currentPlan`, `gate` |
| `KaguraQuotaError` | MCP `quota_exceeded` / `CONNECTOR-001`, and `rate_limit_exceeded`, the daily MCP call cap every non-read-only tool checks (`quotaType` `api_mcp_daily`, `resetsAt` the next UTC midnight); REST `QUOTA-001`, `QUOTA-002` and `CONNECTOR-001` (the resource-token and connector seat caps answer **403**); any other 429 from a REST client but `SecretClient` | `quotaType`, `current`, `limit`, `usedToday`, `resetsAt`, `retryAfter`, and the plan fields above |
| `KaguraPartialRollbackError` | `rollbackSleepRun` reversed some actions but not all | `reportId`, `summary` |
| `KaguraResponseError` | a successful response the SDK cannot read, usually because the server is newer than this SDK. The message reads as the Python SDK's: the call, then the failing fields, never their values (`<operation>: unexpected server response for <Model> (<field>: Field required). …`), then a suggestion to upgrade. It is not a `KaguraConnectionError`: a retry fails the same way | `operation` |
| `KaguraPermissionError` | MCP `permission_denied` — usually the caller's role is too low. `updateSearchConfig` also sends it for a context that does not exist or that the caller cannot see. Only some tools send a role — `updateSearchConfig`, `updateContext`, `deleteContext`, the file tools and the analysis tools do not — so `requiredRole` is often `null`, and on `updateSearchConfig` it cannot tell a missing context from a role denial | `requiredRole` |
| `KaguraError` | any other code | — |

memory-cloud v0.75.0+ tags every plan and quota refusal with a `gate`
(`plan`, `quota`, `allowlist` or `deployment`), and the SDK chooses the
class from it first, falling back to the code for older servers. The
payload fields are `null` whenever the server did not send them. Against a
server older than v0.75.0, `current` and `limit` are read from the legacy
names the refusal carries instead (`used_today` / `limit_today`,
`owned_count` / `cap`, `active_connectors` / `max_connectors`).

Show `requiredPlanDisplay` (`"XL"`) to a user and decide with
`requiredPlan`, as long as `gate` is set. With a `gate`, both are `null`
when no plan lifts the refusal, which is what an `allowlist` or
`deployment` gate means, and a `quota` gate is set on every typed cap,
including one no tier raises, so an upgrade helps only when `requiredPlan`
is non-null. With no `gate`, a `null` `requiredPlan` means the plan is
unknown, not that no plan lifts it. That covers an older server, and
`createContext`'s own context-limit check, which reads `listContexts()`
and so fills in only `quotaType`, `current` and `limit`.

`retryAfter` is the `Retry-After` header, else the retry hint in the body
(REST `details.retry_after`, MCP `retry_after_seconds`, which is all the
resource events-per-hour quota sends), else it is derived from `resetsAt`
on a time-windowed quota such as `memories_per_day`. It is `null` on a
fixed cap that waiting will not lift.

An HTTP 429 keeps the class it always had on two surfaces.
`KaguraClient`'s own transport raises `KaguraRateLimitError` for the
per-minute rate limit and the daily call quota alike; from v0.75.0 the
quota also sets the `KaguraQuotaError` fields on it (`quotaType` is
`api_mcp_daily` or `api_rest_daily`), and they stay `null` on a
per-minute limit. A tool that refuses the daily MCP cap itself, in its
reply rather than with a 429, raises the `KaguraQuotaError` above.
`SecretClient` renders a 429 as `KaguraConnectionError`.

```ts
import { KaguraFeatureNotAvailableError, KaguraQuotaError } from "kagura-memory";

try {
  // The context is named after the resource unless you pass `name`.
  await client.setupResource({ resourceId: "crm" });
} catch (e) {
  if (e instanceof KaguraFeatureNotAvailableError) {
    // null when no plan lifts it (allowlist / deployment gate) or, with no gate, unknown.
    console.log(e.requiredPlanDisplay ? `upgrade to ${e.requiredPlanDisplay}` : e.message);
  } else if (e instanceof KaguraQuotaError) {
    console.log(`${e.quotaType}: ${e.current}/${e.limit}`);
  }
}
```

## `KaguraClient` method reference

Methods return the parsed server response. Most take a single camelCase
options object (optional for `listContexts` and `listMemories`);
`getAgent`, `deleteAgent`, `listAgentBindings` and `deleteContext` take
the id directly, and the workspace-wide calls (`listAgents`, `getUsage`,
`getServerInfo`, `checkServerVersion`, `getEmbeddingStatus`,
`listEmbeddingModels`, `getToolDefinitions`, `close`) take no arguments.
The wire stays snake_case; optional fields are omitted from the request
when `undefined`.

### Memories

| Method | What it does |
|--------|--------------|
| `remember` | Store a memory. `details` accepts arbitrary JSON, including `location` (see below) and the reserved `tool_trigger`, which marks a tool guardrail and needs context editor or above on a user (not agent) credential; `supersedes` declares this the newer version of an existing memory, shadowing the old one from default recall without destroying it; `deliveryMode: "always"` pins it. |
| `recall` | Hybrid semantic + keyword search. Takes `filters` (`type`, `scope`, `tags` with `tags_match` and `tags_normalize`, `importance` bounds, created/updated date bounds, `source_uri_prefix`, `source_type`, `trust_tier`, and the `near` / `within` geo filters), `searchMode`, `useRerank`, `includeExploreHints`, `includeSuperseded` (read back what `supersedes` shadowed, annotated with `superseded_by`), and `contextIds` for 2–20-context search. `useRerank` is tri-state (memory-cloud v0.69.0+): omit it to follow the context's search config (the first context's, with `contextIds`), `true` requests reranking where the context allows it, `false` skips it for the call. A tag filter that matches nothing can return `tag_suggestions`. When the semantic half is unavailable, the result is keyword-only and carries `degraded: true` and `degraded_reason` (v0.66.0+) — an empty one then means "search impaired", not "nothing stored". |
| `reference` | Full detail for one memory, under `result.memory`. |
| `updateMemory` | Update in place by `memoryId`, or upsert by `externalId`. `details` **replaces** the stored object wholesale — round-trip keys you want to keep; dropping `tool_trigger` turns a guardrail off. `dismissSupersedeCandidate: true` rejects the server's `supersede_candidate` suggestion; it needs `memoryId` and throws locally with `externalId`. |
| `forget` | Soft-delete by `memoryId` or by `query`. The rows are kept, but not restorable through the API, until the deployment's cleanup window passes (`CLEANUP_DELETED_MEMORIES_RETENTION_DAYS`, default 30 days). For a caller who may write to the workspace, a target it may not delete, or one already gone, is skipped silently — including every guardrail for a caller below context editor or on an agent credential — so `deleted_count` can be 0. A workspace viewer may not delete at all and is refused with `KaguraPermissionError` (`requiredRole: "member"`). |
| `listMemories` | Browse with substring, facet, time-window and bounding-box filters. Omit `contextId` for the caller's cross-context view. `latMin` / `latMax` / `lonMin` / `lonMax` (server v0.54.0+) keep only memories with a location, each then carrying `location: { lat, lon }`; see [the WHERE axis](#the-where-axis--geospatial-memories). |

### Deterministic lanes

These bypass ranking entirely — same inputs, same rows, every call. They are
the counterpart to `recall`'s probabilistic search.

| Method | Axis |
|--------|------|
| `loadPinned` | The complete, unranked `deliveryMode: "always"` set. Bounded: check `truncated` / `total_available` rather than assuming you got everything. |
| `loadGuardrails` | The set a client-side tool hook matches against (server v0.74.0+): the pinned set plus every memory carrying `details.tool_trigger`, in two separately capped lanes — `cap` bounds only the tool-triggered one, so pins never crowd guardrails out. Check `tool_triggered_truncated` / `pinned_truncated`. |
| `recallUpcoming` | WHEN — `type: "time"` memories whose window overlaps `from`/`until`, soonest first. Items carry `trigger`, not `details` (server v0.73.0+); `includeDetails: true` returns the full `details` object instead. |
| `recallNearby` | WHERE — memories near a point, nearest first with `distance_m`. See [the WHERE axis](#the-where-axis--geospatial-memories). |
| `recordMeasurement` | HOW-MUCH — append one number to a metric's series (server v0.54.0+). Not a memory: never embedded, recalled or consolidated. Append-only, with no delete. See [the HOW-MUCH axis](#the-how-much-axis--measurement-series). |
| `recallSeries` | HOW-MUCH — one metric's series, bucketed by `period` (`day`, `week`, `month`) and aggregated by `agg` (`avg`, `min`, `max`, `sum`, `count`, `last`), UTC-aligned, empty buckets omitted. `count` is buckets, not observations. |

### Tags and the neural graph

| Method | What it does |
|--------|--------------|
| `listTags` | Tag vocabulary with counts and recency. `prefix` narrows by spelling; `withTags` is a multi-tag AND drill-down that also excludes those tags from the result — the two compose into server-side faceted browsing with no local index. A drill-down calls the REST tags endpoint, because the MCP tool ignores `withTags` (through server v0.76.0); the result has the same shape. Its `context_name` is the one the endpoint sends (server v0.77.0+), else one MCP `list_tags` call names the context, once per client. Its values are trimmed and blank ones dropped, and at most 50 of up to 200 characters each are accepted. |
| `explore` | Graph traversal from a seed memory (`depth` 1–5, `minWeight`). |
| `listEdges` | Edges touching a memory, incoming and outgoing, deduplicated. |
| `createEdge` / `updateEdge` / `deleteEdge` | Manual edge curation. `(sourceId, targetId)` is the identity; self-loops are rejected. |
| `findDuplicates` | Near-duplicate pairs above `threshold` (0.5–1.0, default 0.90). |
| `feedback` | Record whether a recalled memory was useful — an append-only signal in its own lane, not a memory edit. |

### Contexts

| Method | What it does |
|--------|--------------|
| `listContexts` | The contexts you can see, most recently used first, as a slim name→id directory (`id`, `name`, `is_private`, `is_locked`, `last_used_at`; server v0.73.0+). `nameContains` filters (server v0.73.0+; older servers ignore it and return every context); `includeSummary` (capped at 300 chars), `includeDetails` (full `summary` + `embedding_model`) and `includeStats` (`memory_count`) add fields. `count` is quota usage and `total` the number returned; `can_create` is the quota flag, and `hint` appears when you can see no context. |
| `createContext` | New context. Throws `KaguraQuotaError` when the workspace limit is reached: the SDK checks `listContexts()` first, so that error carries `quotaType`, `current` and `limit` but no `gate` or plan fields (`requiredPlan` `null` means unknown). Also throws `KaguraFeatureNotAvailableError` for a shared one (`isPrivate: false`) on a plan without shared contexts (server v0.75.0+). `embeddingModel` cannot be changed through the API afterwards (an operator can migrate it server-side, v0.66.0+). `resourceId` is deprecated and no longer sent, since the server ignores it: set it with `updateContext`, or use `setupResource`. |
| `getContextInfo` | Metadata plus, by default, a memory-count breakdown. On server v0.74.0+ also a trimmed `guardrails` block: absent when the MCP URL carries `?guardrails=off`, `null` when the server's read failed. |
| `updateContext` | Change display name, summary, usage guide, visibility, lock. `isPublic: true` is plan-gated and throws `KaguraFeatureNotAvailableError` on a plan without public contexts. |
| `deleteContext` | Delete by id. Locked contexts are refused. |
| `mergeContexts` | Move memories between contexts. Both must share an embedding model and workspace. |
| `updateSearchConfig` | Hybrid-search weights (must sum to 1.0 ±0.01), reranking (`useRerank`, which a `recall` that omits it follows) and the reranker (`voyage`, `cohere` or `self_hosted`), reinforce re-rank (`reinforceEnabled`, `reinforceMaxBoost`, `reinforceRequireHostArbitration`) and query routing (`routingMode`). Owner/editor only; a context that does not exist, or that the caller cannot see, also throws `KaguraPermissionError`. Returns the whole updated `config`, the only place the reinforce and routing fields come back. |
| `setupResource` | Context + resource entity + ingestion token in one transaction. The returned token is plaintext and shown once. The context is named `name`, or `resourceId` when that is omitted. `summary` is deprecated and no longer sent, since the server ignores it: set it afterwards with `updateContext`. Plan-gated: throws `KaguraFeatureNotAvailableError` on a plan without resources. |

### Agent run-state

Ephemeral, TTL-bounded, and excluded from recall — deliberately not memories.

| Method | What it does |
|--------|--------------|
| `setState` / `getState` | Key/value at `(contextId, key)`. Omit `key` on read to list all live keys. |

### Sleep maintenance

| Method | What it does |
|--------|--------------|
| `getSleepHistory` | Recent runs, newest first. |
| `getSleepReport` | One run in detail, including the per-action audit log. |
| `rollbackSleepRun` | Reverse a completed or degraded run. The server commits per step, so a partial rollback is possible: it throws `KaguraPartialRollbackError` instead of returning, and the steps it did reverse stay reversed. There is no retry: the report is now `failed`, and the server will not roll back a `failed` report again. `err.summary` has the same counts a clean run returns, and the actions in `err.summary.errors` were not reversed and need handling some other way. |

### Workspace and server

| Method | What it does |
|--------|--------------|
| `getServerInfo` | Version, deployment feature flags, and (v0.69.0+) the reranker defaults new contexts start with, under `search_defaults`. |
| `checkServerVersion` | Compare against `MIN_SERVER_VERSION` (0.75.0). Advisory: logs, never throws. Reads the version as the Python SDK does: `v0.75.0`, `0.75.0+build` and `0.75.0.post1` meet it, a pre-release of it (`0.75.0-rc1`, `0.75.0rc1`, `0.75.0.dev1`) does not, and a version it cannot read (`0.75`, or not a string) is not compared. |
| `getUsage` | Workspace quota and usage: `used` / `limit` for memories, contexts, members and today's MCP calls. |
| `getMemoryStats` | Per-memory usage stats, sortable and paged. |
| `getEmbeddingStatus` / `listEmbeddingModels` | Embedding backend state and the models available for `createContext`. |
| `getToolDefinitions` | Raw MCP `tools/list` output — every tool the server exposes, including any this SDK does not wrap yet. |
| `callRawTool` | Call any MCP tool by name — the escape hatch for tools with no typed wrapper. Args pass through verbatim (wire form: `context_id`, not `contextId`) and the result is untyped. Prefer a wrapper where one exists; use this so a missing one is a detour, not a dead end. |
| `close` | Drop the MCP session. The next call re-initializes automatically. |

Agent Registry and binding methods are covered in
[Agent control plane](#agent-control-plane-memory-cloud-v0490) below.

## Agent control plane (memory-cloud v0.49.0+)

`KaguraClient` wraps the RFC-0002 agent platform: the **Agent Registry**
(`registerAgent` / `listAgents` / `getAgent` / `updateAgent` /
`deleteAgent`), subtractive **context bindings** (`bindAgentContext` /
`listAgentBindings` / `updateAgentBinding` / `unbindAgentContext`), and
the session-start `getAgentBootstrap` call. Registry and binding methods are
**owner/admin-gated** server-side; `deleteAgent` is permanent and
cascades every API key bound to the agent (prefer
`updateAgent({ status: "retired" })` for operational retirement).

```ts
// One-time provisioning (owner/admin): register the agent, bind its context
const agent = await client.registerAgent({ name: "ci-agent", framework: "claude-code" });
await client.bindAgentContext({ agentId: agent.id, contextId: "ctx-uuid", isDefault: true });

// Session start: rehydrate cognitive state in one call
const bootstrap = await client.getAgentBootstrap({
  agentId: agent.id,          // contextId omitted → default binding
  sessionId: "run-42",        // echoed in the correlation block
  query: "session summary",   // enables the trusted-only recall component
});
if (bootstrap.degraded) {
  // some component failed fail-soft; inspect bootstrap.components
}
if (bootstrap.components?.recall?.degraded) {
  // the recall ran keyword-only (degraded_reason says why); this also sets
  // the top-level flag above, since server v0.66.0
}
```

Deployed agents holding only an API key (e.g. an agent-bound member key)
can bootstrap over REST without an MCP session:

```ts
import { AgentsClient } from "kagura-memory";

const agents = AgentsClient.fromMcpUrl();
const bootstrap = await agents.bootstrap({ agentId: "agent-uuid" });
```

Requires memory-cloud **v0.49.0+** — older servers return MCP "tool not
found" / REST 404 on this surface. The SDK as a whole targets v0.75.0
(see [Installation](#installation)).

## Tool guardrails over REST (memory-cloud v0.74.0+)

`MemoryClient` serves a context's tool guardrails to a caller holding only
an API key, an agent-bound key included, with no MCP session:

| Method | What it does |
|--------|--------------|
| `getGuardrailDigest` | The rendered tool-triggered set for clients without tool hooks (`GET /api/v1/memory/guardrails/digest`). `target: "export"` (the default) returns the `AGENTS.md` block, between its marker lines, or `""` when the context has none; `"instructions"` returns the exact MCP server instructions this credential would receive, and `profile` / `tools` repeat the MCP URL's `?profile=` / `?tools=`. `tool_triggered_version` is the response header, `null` when absent. The text is returned as is. |
| `loadGuardrails` | The REST twin of `KaguraClient.loadGuardrails` (`POST /api/v1/memory/guardrails`): the same two lanes and truncation flags, without the context block (`context_id` and `context_name` are `null`). The set is read as the Python SDK's `GuardrailSet` model reads it, by the same reader `guardrails load` prints with: the model's fields only, in its order, `null` for an optional one left out (so `GuardrailItem`'s optional fields and `ToolTrigger.match` are typed nullable), and a `tool_trigger` that is no trigger `null`. A set missing a required field, a truncation flag included, or holding one of the wrong type (`pinned.0.type: Input should be a valid string`) raises `KaguraResponseError` (`operation` `MemoryClient.load_guardrails`) rather than read as complete. |

Both refuse a `contextId` that is not a UUID before any request, in the
Python SDK's words (`context_id must be a UUID, got '…'`), and send its
canonical form. The 404 (`KaguraNotFoundError`) is uniform: an unknown
context, one in another workspace, and one the credential may not read
all look the same, and so does a server older than v0.74.0 answering
`getGuardrailDigest`. That older server answers `loadGuardrails` with
`HTTP 405` instead, a `KaguraConnectionError`, so a caller that detects
an older server by catching `KaguraNotFoundError` must also expect the
405. An OAuth token's scope follows the HTTP method, so
`loadGuardrails`, a `POST`, needs `memory:write`: a `--read-only` login
loads the set over MCP instead.

```ts
import { MemoryClient } from "kagura-memory";

const memory = MemoryClient.fromMcpUrl();
const digest = await memory.getGuardrailDigest("ctx-uuid");
if (digest.text) {
  // The block between the kagura-memory:guardrails marker lines for AGENTS.md.
}
```

## The WHERE axis — geospatial memories

Any memory can carry a location under `details.location`, which makes it
reachable from `recallNearby()` — a deterministic spatial query (nearest
first, each result carrying `distance_m`), not semantic search.

```ts
await client.remember({
  contextId,
  summary: "Coffee shop with reliable wifi",
  content: "...",
  details: { location: { lat: 35.6812, lon: 139.7671, label: "Tokyo Station" } },
});

const near = await client.recallNearby({ contextId, lat: 35.68, lon: 139.76, radiusM: 500 });
```

`lat`/`lon` must be JSON **numbers** — argument coercion does not recurse
into `details`, so `"35.68"` is rejected server-side with HTTP 422.
`recallNearby()` returns a typed `RecallNearbyResponse`
(`results[].distance_m`); `MemoryLocation` and `NearbyMemory` are exported
too. Out-of-range coordinates throw locally rather than round-tripping.

`listMemories()` filters by a bounding box instead (server v0.54.0+):
`latMin`, `latMax`, `lonMin` and `lonMax`, in any combination, keep only
memories with a location, and each item carries `location: { lat, lon }`
(`null` without one). `lonMin > lonMax` is the box across the
antimeridian. A server older than v0.54.0 ignores the bounds and returns
an unfiltered page.

```ts
const pacific = await client.listMemories({ contextId, lonMin: 170, lonMax: -170 });
```

> **Gotcha:** `updateMemory()` replaces `details` **wholesale** — the
> server does not deep-merge. Round-trip `location` when updating details
> or the memory silently drops off the spatial axis.

## The HOW-MUCH axis — measurement series

Numbers such as a weight, a daily revenue or a rep count go to a lane of
their own (server v0.54.0+): never embedded, never returned by `recall()`,
never merged or rewritten by Sleep. Keep prose ("hit goal weight") in
`remember()`.

```ts
await client.recordMeasurement({ contextId, metric: "weight_kg", value: 71.5, unit: "kg" });

const weekly = await client.recallSeries({ contextId, metric: "weight_kg", period: "week", agg: "avg" });
// weekly.series: [{ bucket: "2026-08-24T00:00:00Z", value: 72, count: 3 }, ...]
```

The lane is append-only: recording the same point twice stores two rows,
and nothing deletes one, except the retention window an operator can set
on the server (v0.55.0+, `SLEEP_MEASUREMENT_RETENTION_DAYS`), which Sleep
rollback cannot undo. `measuredAt`, `start` and `end` take an ISO 8601
string, sent as given (naive means UTC), or a `Date`. A series window
defaults to the last 30 days and spans at most 365; the server refuses a
wider one. The metric (1-64 characters), the value (a finite number) and
the unit (1-32 characters) are checked before any request, with the Python
SDK's messages. Both methods return the Python SDK's model, and a result
that does not read as one throws `KaguraResponseError`. On the command
line: `measure record` and `measure series`.

## Upload and ingest progress

`FilesClient.upload` and `ResourceClient.ingestEvents` take an
`onProgress` callback, the Python SDK's `logger=` hook. Each event is the
Python CLI's NDJSON line without its `v` and `ts`: `stage`, `kind`
(`action`, then one `success` or `error`, the last event, even when the
call throws), and `msg` and `detail` when they are not empty. Without a
callback nothing is emitted, and a callback that throws, or an `async` one
that rejects, is ignored; its promise is not awaited.

```ts
import { FilesClient, type ProgressEvent } from "kagura-memory";

const files = FilesClient.fromMcpUrl();
await files.upload({
  contextId: "workspace-uuid",
  source: "./report.pdf",
  onProgress: (e: ProgressEvent) => console.error(e.stage, e.kind, e.msg),
});
```

An upload reports `reserve`, `upload` and `confirm`, then `complete`: a
`success` with `{ file_id, size_bytes }` (`{ file_id, deduped: true }` for
a 409 dedup hit), or an `error` with how far it got,
`{ reserved_file_id, uploaded, confirm_started, confirmed }`;
`confirm_started` without `confirmed` means the file may be finalized
after all, so check before uploading again. A batch reports
`ingest_events`, then `{ created, failed }` or
`{ events_attempted, resource_id }`. A 2xx answer neither call can read (a
batch answered with `null`; a reserve, a confirm or a 409's existing file
that the Python SDK's `FileReserveResponse` / `FileObject` model refuses,
such as a confirm with no `created_at`) ends the stream with that `error`
and throws a `KaguraResponseError` in the Python SDK's words, a reserve
before the PUT; such a confirm is not `confirmed`. A reserve whose
`file_id` is `.`, `..` or empty ends it the same way, before the PUT, with
this SDK's own message (`file_id must be a file id, got "..": …`); the
Python SDK accepts it and confirms at another route. `list` and
`downloadUrl` read their body through the Python SDK's model too
(`FileObject` for each item of a bare list, else `FileListResponse`;
`FileDownloadUrlResponse`), and throw the same error for one it refuses. Every `FilesClient` method refuses a
`contextId` that is not a UUID in the Python SDK's words (`context_id must
be a UUID; got '…'`), and sends a `{braced}`, `urn:uuid:` or dashless one
in its canonical form.

Every id a client puts in a URL path (a `FilesClient` file id, a
`ResourceClient` resource id, `KaguraClient`'s context id for memory
stats, duplicates and the tags drill-down, a `WorkspaceClient` user id, a
`SecretClient` pubkey id) is percent-encoded as one segment, and an id
that is `.`, `..` or empty throws before anything is sent
(`fileId must be a file id, got "..": as a URL path segment it would
address a different endpoint`): encoding leaves those as they are, and
URL resolution would send the request elsewhere. The Python SDK sends
them as typed, but for a workspace user id, which it refuses too from
0.41.1
([#66](https://github.com/kagura-ai/kagura-memory-typescript-sdk/issues/66)).

## Zero-knowledge secrets

`SecretClient` is the fourth REST client, alongside Files, Resource and
Workspace. The server stores **only opaque ciphertext**: values are
encrypted to [age](https://age-encryption.org) recipients on your machine
and decrypted there, so a workspace admin — or the server operator — can
enumerate secret names and grants but never read a value.

```ts
import { SecretClient, KeyManager, decrypt } from "kagura-memory";

const secrets = SecretClient.fromMcpUrl();

// One-time: enroll this machine's age key and register the public half.
// `store` is yours to supply — see "Key custody is yours to wire" below.
const keys = new KeyManager({ store: myKeyStore });
const { recipient, fingerprint } = await keys.enroll();
await secrets.registerPubkey(recipient, "ci-runner");
// ...an owner approves it (verify `fingerprint` out of band first).

// Store a value, encrypted to every approved recipient.
const active = (await secrets.listPubkeys()).filter((p) => p.status === "active");
await secrets.putSecretForRecipients({
  name: "openai/api-key",
  plaintext: "sk-live-...",
  recipients: active,
});

// Read it back.
const { ciphertext } = await secrets.fetchSecret("openai/api-key");
const value = await decrypt(ciphertext, await keys.getIdentity());
```

Also: `listSecrets`, `revokeGrant`, `deleteSecret`, `verifyAudit`,
`approvePubkey` / `revokePubkey` / `listMyPubkeys`, and the low-level
`putSecret` when you want to build the grant lists yourself.

Names may contain `/` — `cloudflare/api-token` is addressable, and each
segment is percent-encoded so the separators stay structural. `deleteSecret`
rejects a name with an empty, `.`, or `..` segment rather than encoding it:
those are RFC 3986 *unreserved*, so encoding does not neutralize them and the
URL parser would resolve them away — `cloudflare/../openai` would have
deleted `openai`.

### The crypto package is opt-in

Encryption needs [`age-encryption`](https://www.npmjs.com/package/age-encryption)
(typage, by age's author — the counterpart of the Rust `pyrage` binding the
Python SDK uses). It is an **optional peer dependency**, so a plain
`npm install kagura-memory` still pulls in nothing:

```bash
npm install age-encryption
```

Everything except `putSecretForRecipients`, `encrypt`, `decrypt`,
`generateKeypair` and `recipientFromIdentity` works without it —
including the whole REST surface, `fingerprint()`, and the armor codec. Call
one of those without the package and you get a `KaguraCryptoError` naming
the install command, not a module-resolution stack trace.

> **On Node 18.** This SDK supports Node 18 and CI exercises the crypto
> round-trip there on every push. But `age-encryption`'s `@noble/*`
> dependencies declare `engines.node: ">= 20.19.0"`, so `npm install
> age-encryption` on Node 18 prints `EBADENGINE` warnings, and an
> `engine-strict=true` npmrc will refuse the install outright. It works —
> WebCrypto is not a global before Node 19, so the SDK installs
> `node:crypto`'s `webcrypto` itself — but if you want the warnings gone,
> use Node 20.19+.

Recipients are X25519-only. `age1pq1…` (post-quantum) and plugin
recipients are rejected even though `age-encryption` would accept them,
because `pyrage` cannot read them and the Python CLI has to be able to
decrypt whatever this SDK writes.

### Key custody is yours to wire

Whoever holds the age private key can decrypt every ciphertext ever shared
with the matching recipient, so `KeyManager` takes a `KeyStore` and this SDK
ships **no default backend**:

```ts
interface KeyStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
```

The Python SDK defaults to the OS keychain via `keyring`. Node has no
stdlib equivalent, and every option is a native module — so a default here
would mean either a native runtime dependency or a plaintext file, and
Python explicitly refuses the latter. Asking you for a store keeps the
fail-closed property with no insecure fallback to land in by accident.
Back it with `keytar`/libsecret in an app, or with the ambient secret
manager in CI. Keys are stored under `identity:{profile}`, the same names
Python uses, so a shared backend interoperates.

## Relationship to the Python SDK

This package ports the Python SDK's core (client, auth, REST clients,
models, the zero-knowledge secret client) and, since 0.8.0, its `kagura`
CLI as `kagura-memory`: 20 of the 21 top-level commands, counting the
`contexts` alias. Only `kagura ingest` is not ported (below);
[Command line](#command-line) lists where the two CLIs still differ.

One thing is deliberately not ported, because it would cost the
zero-dependency promise:

- **The document-ingestion pipeline** (`FileIngestor`, `kagura ingest`),
  which needs text extraction from PDF, Office, EPUB and audio plus LLM
  providers.

(`KaguraAgent` and `kagura process` were removed from the Python SDK in
v0.37.0 — the actor role lives in the
[kagura-agent](https://pypi.org/project/kagura-agent/) package, so neither
will be ported here.)

Use the Python SDK for those. Both SDKs share the same credential files
and server APIs, so they interoperate — with one exception, noted above:
age private keys are custodied differently and are **not** readable across
the two. See
[`docs/design/2026-07-05-typescript-port-design.md`](docs/design/2026-07-05-typescript-port-design.md)
for the original scope decisions.

## Development

```bash
npm install
npm test                   # vitest
npm run test:no-webcrypto  # the same suite with globalThis.crypto deleted
npm run typecheck          # tsc --noEmit
npm run build              # tsup → dist/ (ESM + CJS + d.ts)
```

`test:no-webcrypto` reproduces Node 18, which has no WebCrypto global —
the crypto path installs `node:crypto`'s `webcrypto` itself, and that used
to break in CI only. `prepublishOnly` runs all four.

## License

MIT
