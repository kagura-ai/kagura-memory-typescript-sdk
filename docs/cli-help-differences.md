# CLI help differences from Python 0.44.0

This is the complete remaining help audit for #111 at an explicit 80-column
width, with Click 8.3.3 and the Python SDK's secret extra installed.
The executable name is substituted **before** Click wraps prose; the raw
Python output is retained alongside it in [the oracle](../test/cli/pythonHelp044.json).

The shared column layout, prose wrapping, range annotations, required markers,
and Usage/Try framing now follow Click. The entries below retain existing
TypeScript command descriptions, aliases, defaults' wording, separate positive
and negative switch rows, or SDK-specific feature surfaces. No claim of byte
identity is made for these entries. Each supported exception's **complete exact
output** is fixed in [the exception fixture](../test/cli/typescriptHelp111.json);
all other supported Python pages are compared directly to the Python oracle.
The audit test also checks that no registered command escapes this comparison.

| Command | Remaining difference |
| --- | --- |
| `(root)` | subcommand list or summaries. |
| `auth` | Usage/description wording; subcommand list or summaries. |
| `auth list` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--json`. |
| `auth login` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--server URL`, `--server TEXT`. |
| `auth logout` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--all`, `-y, --yes`. |
| `auth refresh` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--no-browser`. |
| `auth revoke-key` | Usage/description wording. |
| `auth status` | Usage/description wording. |
| `auth token` | Usage/description wording. |
| `context search-config` | option text, metavar, default wording, or switch grouping: `--rerank`, `--no-rerank`, `--content-chunks`, `--no-content-chunks`, `--llm-selector`, `--no-llm-selector`, `--rerank / --no-rerank`, `--content-chunks / --no-content-chunks`, `--llm-selector / --no-llm-selector`. |
| `context update` | option text, metavar, default wording, or switch grouping: `--lock`, `--unlock`, `--lock / --unlock`. |
| `edge create` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--type TEXT`, `--weight FLOAT`, `--confidence FLOAT`. |
| `edge list` | option text, metavar, default wording, or switch grouping: `--min-weight FLOAT`. |
| `edge update` | Usage/description wording. |
| `explore` | option text, metavar, default wording, or switch grouping: `-d, --depth INTEGER`, `-w, --min-weight FLOAT`. |
| `files upload` | Usage/description wording. |
| `ingest` | Python's optional URL/local-file ingest command is not implemented in this SDK; it is absent from the root list. |
| `list` | option text, metavar, default wording, or switch grouping: `--order-by [updated_at\|created_at\|importance\|observed_at\|event_start]`, `--order-by [updated_at\|created_at\|importance\|observed_at]`. |
| `recall` | option text, metavar, default wording, or switch grouping: `-k INTEGER`, `--rerank`, `--no-rerank`, `--rerank / --no-rerank`. |
| `remember` | option text, metavar, default wording, or switch grouping: `-t, --type TEXT`, `-i, --importance FLOAT`. |
| `resource events` | Usage/description wording; option text, metavar, default wording, or switch grouping: `-l, --limit INTEGER RANGE`, `--op [upsert\|delete]`, `-V, --version INTEGER`, `--since TEXT`. |
| `resource indexer-status` | Usage/description wording. |
| `resource ingest` | option text, metavar, default wording, or switch grouping: `-k, --api-key TEXT`, `--op [upsert\|delete]`, `-V, --version INTEGER`, `-p, --payload TEXT`. |
| `resource ingest-batch` | Usage/description wording; option text, metavar, default wording, or switch grouping: `-k, --api-key TEXT`, `-f, --file FILENAME`. |
| `resource setup` | option text, metavar, default wording, or switch grouping: `-s, --summary TEXT`, `-q, --quota INTEGER RANGE`. |
| `resource tokens` | subcommand list or summaries. |
| `resource tokens create` | Usage/description wording; option text, metavar, default wording, or switch grouping: `-r, --resource-id TEXT`, `-d, --description TEXT`, `-q, --quota INTEGER RANGE`, `-q, --quota INTEGER`. |
| `resource tokens list` | option text, metavar, default wording, or switch grouping: `-l, --limit INTEGER`. |
| `resource tokens revoke` | Usage/description wording. |
| `resource tokens update` | Usage/description wording; option text, metavar, default wording, or switch grouping: `-d, --description TEXT`, `-q, --quota INTEGER RANGE`, `-q, --quota INTEGER`. |
| `secret` | Usage/description wording; subcommand list or summaries. |
| `secret delete` | Usage/description wording; option text, metavar, default wording, or switch grouping: `-y, --yes`. |
| `secret get` | option text, metavar, default wording, or switch grouping: `-o, --output FILE`, `--reveal`, `--version INTEGER`, `--profile TEXT`. |
| `secret grant` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--to PUBKEY_ID`, `--profile TEXT`, `--to TEXT`. |
| `secret keygen` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--profile TEXT`, `--label TEXT`, `--no-register`, `--reveal`. |
| `secret pubkeys` | option text, metavar, default wording, or switch grouping: `--mine`. |
| `secret put` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--to PUBKEY_ID`, `--from-file PATH`, `--profile TEXT`, `--to TEXT`, `--from-file FILE`. |
| `secret revoke` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--to PUBKEY_ID`, `--to TEXT`. |
| `secret rotate` | option text, metavar, default wording, or switch grouping: `--from-file PATH`, `--profile TEXT`, `--from-file FILE`. |
| `setup claude` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--mcp-url URL`, `-c, --context-id TEXT`, `--profile TEXT`, `--project-dir DIR`, `-y, --non-interactive`, `--guardrails off\|CONTEXT_ID`, `--scope [project\|user]`, `--context CONTEXT_ID`, `--session-hook`, `--no-session-hook`, `--sync-hook`, `--no-sync-hook`, `--commands`, `--no-commands`, `--no-auto-context`, `--mcp-url TEXT`, `--context-id TEXT`, `--project-dir TEXT`, `--session-hook / --no-session-hook`, `--sync-hook / --no-sync-hook`, `--commands / --no-commands`. |
| `setup codex` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--profile TEXT`, `-c, --context-id TEXT`, `--guardrails off\|CONTEXT_ID`, `--tool-profile NAME`, `--add-tools NAME[,NAME...]`, `--url-form`, `--mcp-url URL`, `--api-key-env VAR`, `-y, --non-interactive`, `--api-key TEXT`, `--project-dir DIR`, `--context-id TEXT`, `--mcp-url TEXT`. |
| `setup hermes` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--profile TEXT`, `-c, --context-id TEXT`, `--tool-profile NAME`, `--add-tools NAME[,NAME...]`, `--agents-md [PATH]`, `--url-form`, `--mcp-url URL`, `--api-key-env VAR`, `-y, --non-interactive`, `--api-key TEXT`, `--project-dir DIR`, `--context-id TEXT`, `--mcp-url TEXT`. |
| `setup openclaw` | Usage/description wording; option text, metavar, default wording, or switch grouping: `--profile TEXT`, `-c, --context-id TEXT`, `--tool-profile NAME`, `--add-tools NAME[,NAME...]`, `--agents-md [PATH]`, `--url-form`, `--mcp-url URL`, `--api-key-env VAR`, `-y, --non-interactive`, `--api-key TEXT`, `--project-dir DIR`, `--context-id TEXT`, `--mcp-url TEXT`. |
| `sleep history` | option text, metavar, default wording, or switch grouping: `--limit INTEGER RANGE`. |
| `workspace invite revoke` | Usage/description wording. |
| `workspace member add` | Usage/description wording. |

In particular, setup describes the Node integration actually installed:
Python's hooks, slash commands and Python-process entry forms are not promised.
Authentication text names this SDK's MCP URL, credential refresh and proxy paths.
Secret text describes this package's locally installed encryption support.
The root retains its legacy aliases and usage epilog.
