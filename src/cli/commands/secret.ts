/**
 * `kagura-memory secret …` — the zero-knowledge secret store.
 *
 * Two things make this group unlike the others.
 *
 * **The optional peer dependency.** Encryption lives in `age-encryption`,
 * which this package declares as an *optional* peer so the zero-dependency
 * promise survives. Python does the same with its `[secret]` extra and
 * degrades to a stub that names the install command; so does this, via the
 * message `KaguraCryptoError` already carries.
 *
 * **Key custody.** Python custodies the age private key in the OS keychain
 * through `keyring`. Node has no stdlib keychain and every binding is a
 * native module, so `KeyManager` ships no default backend — a decision
 * recorded in `secrets/keyManager.ts`, which explicitly rejects both a
 * native dependency and a plaintext file. The CLI therefore reads the
 * identity from an environment variable or a file the operator names:
 *
 *   KAGURA_AGE_IDENTITY       the AGE-SECRET-KEY-1… value itself
 *   KAGURA_AGE_IDENTITY_FILE  a path to read it from
 *
 * With neither set, every command that needs the private key fails closed
 * with instructions. **A key custodied by the Python CLI's keyring is not
 * visible here, and vice versa** — that is the cost of not adding a native
 * dependency, and it is stated rather than papered over.
 */

import * as fs from "node:fs";

import { decrypt, fingerprint, generateKeypair, recipientFromIdentity } from "../../secrets/crypto.js";
import type { PubkeyResponse } from "../../models.js";
import { requireArg, rejectExtraArgs, type Command, type CommandDeps, type CommandGroup } from "../command.js";
import { formatJson } from "../output.js";
import { CliError, CliUsageError, parseIntOption } from "../parse.js";
import type { FlagSpec, ParsedArgs } from "../parseArgs.js";
import { resolveConfig, restOptions, runAndPrint } from "../runClientCommand.js";

const PROFILE: FlagSpec = {
  name: "profile",
  type: "value",
  help: "Your key profile",
  defaultLabel: "default",
};
const TO_MULTI: FlagSpec = {
  name: "to",
  type: "multiple",
  metavar: "PUBKEY_ID",
  help: "Recipient pubkey id (repeatable). Default: yourself.",
};
const TO_ONE: FlagSpec = { name: "to", type: "value", metavar: "PUBKEY_ID", required: true };
const FROM_FILE: FlagSpec = {
  name: "from-file",
  type: "value",
  metavar: "PATH",
  help: "Read the value from a file instead of stdin",
};

const IDENTITY_HELP =
  "No age private key available.\n" +
  "  Set KAGURA_AGE_IDENTITY to the AGE-SECRET-KEY-1… value, or\n" +
  "  KAGURA_AGE_IDENTITY_FILE to a file containing it.\n" +
  "  Generate one with: kagura-memory secret keygen\n" +
  "  (Keys custodied by the Python CLI's keyring are not readable from Node.)";

/** Read the operator-provided identity, or fail closed. */
function readIdentity(env: NodeJS.ProcessEnv = process.env): string {
  const inline = env.KAGURA_AGE_IDENTITY?.trim();
  if (inline) return inline;
  const file = env.KAGURA_AGE_IDENTITY_FILE?.trim();
  if (file) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf-8");
    } catch (e) {
      throw new CliError(
        `cannot read KAGURA_AGE_IDENTITY_FILE (${file}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("AGE-SECRET-KEY-1"));
    if (line === undefined) {
      // Never echo the file's contents: it is a private key.
      throw new CliError(`${file} contains no AGE-SECRET-KEY-1 line.`);
    }
    return line;
  }
  throw new CliError(IDENTITY_HELP);
}

// ---------------------------------------------------------------------
// commands that need no private key
// ---------------------------------------------------------------------

const list: Command = {
  summary: "List secret metadata (never the values).",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => makeSecretClient(deps, config).listSecrets());
  },
};

const pubkeys: Command = {
  summary: "List recipient pubkeys.",
  spec: { flags: [{ name: "mine", type: "switch", help: "Only your own pubkeys" }] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const mine = args.flags.has("mine");
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => {
      const client = makeSecretClient(deps, config);
      return mine ? client.listMyPubkeys() : client.listPubkeys();
    });
  },
};

const approve: Command = {
  summary: "Approve a pending pubkey (owner only).",
  args: "PUBKEY_ID",
  spec: { flags: [] },
  run: async (deps, args) => {
    const pubkeyId = requireArg(args, 0, "PUBKEY_ID");
    rejectExtraArgs(args, 1);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => makeSecretClient(deps, config).approvePubkey(pubkeyId));
  },
};

const revoke: Command = {
  summary: "Revoke one recipient's grant.",
  args: "NAME",
  spec: { flags: [{ ...TO_ONE, help: "Recipient pubkey id to revoke" }] },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    const to = requireValue(args, TO_ONE);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => makeSecretClient(deps, config).revokeGrant(name, to));
  },
};

const deleteSecret: Command = {
  summary: "Hard-delete a secret and all its versions + grants (owner only).",
  args: "NAME",
  spec: { flags: [{ name: "yes", short: "y", type: "switch", help: "Skip the confirmation prompt" }] },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    if (!args.flags.has("yes") && !(await deps.confirm(`Hard-delete secret '${name}' and all versions?`))) {
      throw new CliError("Aborted!");
    }
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, async () => {
      await makeSecretClient(deps, config).deleteSecret(name);
      return { status: "success", name };
    });
  },
};

const auditVerify: Command = {
  summary: "Verify the tamper-evident audit chain (owner/admin).",
  spec: { flags: [] },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, () => makeSecretClient(deps, config).verifyAudit());
  },
};

// ---------------------------------------------------------------------
// commands that need the private key
// ---------------------------------------------------------------------

const keygen: Command = {
  summary: "Generate an age keypair and register the public half.",
  description:
    "  The private key is PRINTED, not stored: this SDK takes no native\n" +
    "  keychain dependency, so custody is yours. Save it somewhere your\n" +
    "  secret manager controls and point KAGURA_AGE_IDENTITY_FILE at it.\n" +
    "  Output is refused on a TTY unless --reveal is given.",
  spec: {
    flags: [
      PROFILE,
      { name: "label", type: "value", help: "Human-readable label for this pubkey" },
      { name: "no-register", type: "switch", help: "Generate only; skip server registration" },
      { name: "reveal", type: "switch", help: "Allow printing the private key to a terminal" },
    ],
  },
  run: async (deps, args) => {
    rejectExtraArgs(args);
    const label = args.values.label;
    const { identity, recipient } = await generateKeypair();

    if (deps.isTty() && !args.flags.has("reveal")) {
      throw new CliError(
        "refusing to print a private key to a terminal. Redirect to a file " +
          "(umask 077 first), or pass --reveal if you really mean it.",
      );
    }

    if (args.flags.has("no-register")) {
      deps.write(formatJson({ recipient, fingerprint: fingerprint(recipient), identity }));
      return 0;
    }
    const { config } = resolveConfig(deps, undefined, false);
    return runAndPrint(deps, async () => {
      const registered = await makeSecretClient(deps, config).registerPubkey(recipient, label);
      return { pubkey: registered, identity };
    });
  },
};

const put: Command = {
  summary: "Store a secret.",
  args: "NAME",
  spec: { flags: [TO_MULTI, FROM_FILE, PROFILE] },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    const value = readSecretValue(deps, args.values["from-file"]);
    const toIds = args.many.to ?? [];
    const { config } = resolveConfig(deps, undefined, false);

    return runAndPrint(deps, async () => {
      const client = makeSecretClient(deps, config);
      const all = await client.listPubkeys();
      const recipients = await selectRecipients(all, toIds);
      return client.putSecretForRecipients({ name, plaintext: value, recipients });
    });
  },
};

const get: Command = {
  summary: "Fetch a secret and decrypt it locally with your key.",
  args: "NAME",
  spec: {
    flags: [
      { name: "output", short: "o", type: "value", metavar: "FILE", help: "Write to FILE (mode 0600)" },
      { name: "reveal", type: "switch", help: "Allow printing to a terminal" },
      { name: "version", type: "value", metavar: "INTEGER", help: "Pin a version (default: latest)" },
      PROFILE,
    ],
  },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    const output = args.values.output;
    const rawVersion = args.values.version;
    const version =
      rawVersion === undefined
        ? undefined
        : parseIntOption({ name: "version", type: "value" }, rawVersion);

    // The TTY guard runs before the fetch: shoulder-surfing is the threat,
    // and there is no point decrypting something we will refuse to show.
    if (output === undefined && deps.isTty() && !args.flags.has("reveal")) {
      throw new CliError(
        "refusing to print a secret to a terminal. Use --output FILE, pipe it, or pass --reveal.",
      );
    }

    const identity = readIdentity();
    const { config } = resolveConfig(deps, undefined, false);
    const client = makeSecretClient(deps, config);
    const fetched = await client.fetchSecret(name, version);
    const plaintext = new TextDecoder().decode(await decrypt(fetched.ciphertext, identity));

    if (output === undefined) {
      deps.write(plaintext);
      return 0;
    }
    writePrivateFile(output, plaintext);
    deps.write(formatJson({ status: "success", name, written_to: output }));
    return 0;
  },
};

const grant: Command = {
  summary: "Grant a recipient access (re-encrypts the secret to them).",
  args: "NAME",
  spec: { flags: [{ ...TO_ONE, help: "Pubkey id to grant" }, PROFILE] },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    const to = requireValue(args, TO_ONE);
    const identity = readIdentity();
    const { config } = resolveConfig(deps, undefined, false);

    return runAndPrint(deps, async () => {
      const client = makeSecretClient(deps, config);
      // Only a current recipient can decrypt, which is what makes this a
      // grant rather than a server-side re-key.
      const fetched = await client.fetchSecret(name);
      const plaintext = await decrypt(fetched.ciphertext, identity);
      const all = await client.listPubkeys();
      // The server records recipients as FINGERPRINTS, not pubkey ids, so
      // the existing set is resolved by fingerprint and the new one by id.
      const keep = byFingerprint(all, fetched.recipients_snapshot);
      const added = all.find((p) => p.id === to);
      if (added === undefined) throw new CliError(`no such pubkey id: ${to}`);
      const recipients = dedupe([...keep, added]);
      return client.putSecretForRecipients({ name, plaintext, recipients });
    });
  },
};

const rotate: Command = {
  summary: "Rotate a secret: encrypt a NEW value to the remaining recipients.",
  args: "NAME",
  spec: { flags: [FROM_FILE, PROFILE] },
  run: async (deps, args) => {
    const name = requireArg(args, 0, "NAME");
    rejectExtraArgs(args, 1);
    const value = readSecretValue(deps, args.values["from-file"]);
    const { config } = resolveConfig(deps, undefined, false);

    return runAndPrint(deps, async () => {
      const client = makeSecretClient(deps, config);
      // Rotation needs the current recipient *set*, not the current value,
      // so it never decrypts — which is why Python's --profile is unused
      // here. The set comes from the stored snapshot of fingerprints.
      const current = await client.fetchSecret(name);
      const all = await client.listPubkeys();
      const recipients = byFingerprint(all, current.recipients_snapshot);
      if (recipients.length === 0) {
        throw new CliError(
          `none of '${name}'’s recipients are still registered; rotating would orphan it.`,
        );
      }
      return client.putSecretForRecipients({ name, plaintext: value, recipients });
    });
  },
};

const exec: Command = {
  summary: "Run COMMAND with secrets injected into its environment.",
  args: "-- COMMAND [ARGS]...",
  description:
    "  Secrets are decrypted locally and passed to the child through its\n" +
    "  environment only — they never touch disk and never appear in argv.\n" +
    "  The child's exit code becomes this command's exit code.",
  passthrough: true,
  spec: {
    flags: [
      { name: "as", type: "multiple", metavar: "ENV=NAME", help: "ENV_NAME=secret_name (repeatable)" },
      PROFILE,
    ],
  },
  run: async (deps, args) => {
    const specs = args.many.as ?? [];
    if (specs.length === 0) throw new CliUsageError("Missing option '--as'.");
    // The router stopped parsing at the first positional and stripped a
    // leading `--`, so these are the child's argv verbatim.
    const argv = args.positionals;
    if (argv.length === 0) throw new CliUsageError("Missing argument 'COMMAND'.");

    const mapping = specs.map((spec) => {
      const eq = spec.indexOf("=");
      if (eq <= 0) {
        throw new CliUsageError(`--as expects ENV_NAME=secret_name, got ${JSON.stringify(spec)}.`);
      }
      return { envName: spec.slice(0, eq), secretName: spec.slice(eq + 1) };
    });

    const identity = readIdentity();
    const { config } = resolveConfig(deps, undefined, false);
    const client = makeSecretClient(deps, config);

    const injected: Record<string, string> = {};
    const decoder = new TextDecoder();
    for (const { envName, secretName } of mapping) {
      const fetched = await client.fetchSecret(secretName);
      injected[envName] = decoder.decode(await decrypt(fetched.ciphertext, identity));
    }
    return deps.spawnChild(argv[0]!, argv.slice(1), injected);
  },
};

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function requireValue(args: ParsedArgs, flag: FlagSpec): string {
  const value = args.values[flag.name];
  if (value === undefined) throw new CliUsageError(`Missing option '--${flag.name}'.`);
  return value;
}

function makeSecretClient(deps: CommandDeps, config: Parameters<typeof restOptions>[0]) {
  return deps.makeSecretClient(restOptions(config));
}

/** Read the secret value from `--from-file` or stdin, never from argv. */
function readSecretValue(deps: CommandDeps, fromFile: string | undefined): string {
  if (fromFile !== undefined) {
    try {
      return fs.readFileSync(fromFile, "utf-8").replace(/\r?\n$/, "");
    } catch (e) {
      throw new CliUsageError(
        `Invalid value for '--from-file': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  // A value on the command line would land in the shell history and in
  // every `ps` listing, so there is deliberately no --value flag.
  const stdin = deps.readStdin();
  if (stdin === null) {
    throw new CliUsageError("no value on stdin; pipe one in or use --from-file PATH.");
  }
  return stdin.replace(/\r?\n$/, "");
}

/** Resolve pubkey ids to the active recipients, defaulting to yourself. */
async function selectRecipients(
  all: PubkeyResponse[],
  ids: string[],
): Promise<PubkeyResponse[]> {
  if (ids.length === 0) {
    const recipient = await recipientFromIdentity(readIdentity());
    const mine = all.find((p) => p.pubkey === recipient);
    if (mine === undefined) {
      throw new CliError(
        "your pubkey is not registered on this workspace; run `kagura-memory secret keygen` first.",
      );
    }
    return [mine];
  }
  const byId = new Map(all.map((p) => [p.id, p]));
  return ids.map((id) => {
    const found = byId.get(id);
    if (found === undefined) throw new CliError(`no such pubkey id: ${id}`);
    return found;
  });
}

/** Resolve a stored fingerprint snapshot back to live pubkey rows. */
function byFingerprint(all: PubkeyResponse[], fingerprints: string[]): PubkeyResponse[] {
  const wanted = new Set(fingerprints);
  return all.filter((p) => wanted.has(p.fingerprint));
}

function dedupe(rows: PubkeyResponse[]): PubkeyResponse[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

/** Write with mode 0600 from creation, never widening an existing file. */
function writePrivateFile(target: string, contents: string): void {
  try {
    fs.writeFileSync(target, contents, { mode: 0o600 });
    // writeFileSync's mode applies only at creation; an existing file keeps
    // its permissions, so tighten explicitly.
    fs.chmodSync(target, 0o600);
  } catch (e) {
    throw new CliError(`cannot write ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const SECRET_GROUP: CommandGroup = {
  summary: "Zero-knowledge secret store — age recipient encryption.",
  commands: {
    keygen,
    list,
    put,
    get,
    grant,
    revoke,
    rotate,
    delete: deleteSecret,
    pubkeys,
    approve,
    "audit-verify": auditVerify,
    exec,
  },
};
