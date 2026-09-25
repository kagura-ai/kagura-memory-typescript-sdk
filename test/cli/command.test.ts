import { describe, expect, it } from "vitest";

import {
  renderGroupHelp,
  renderHelp,
  requireArg,
  requireChoice,
  requireOption,
  type Command,
} from "../../src/cli/command.js";
import { CliUsageError } from "../../src/cli/parse.js";
import { parseArgs, type FlagSpec } from "../../src/cli/parseArgs.js";

const ROLE: FlagSpec = { name: "role", type: "value", metavar: "[member|admin|viewer]" };
const ROLES = ["member", "admin", "viewer"] as const;

function usage(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(CliUsageError);
    return (e as Error).message;
  }
  throw new Error("expected a usage error");
}

describe("requireChoice", () => {
  it("lists the choices when the option is missing, as click does", () => {
    const args = parseArgs(["add", "u1"], { flags: [ROLE] });
    expect(usage(() => requireChoice(args, ROLE, ROLES))).toBe(
      "Missing option '--role'. Choose from:\n\tmember,\n\tadmin,\n\tviewer",
    );
  });

  it("checks a given value case-sensitively", () => {
    const args = parseArgs(["add", "--role", "Admin"], { flags: [ROLE] });
    expect(usage(() => requireChoice(args, ROLE, ROLES))).toBe(
      "Invalid value for '--role': 'Admin' is not one of 'member', 'admin', 'viewer'.",
    );
  });

  it("returns a valid choice", () => {
    const args = parseArgs(["add", "--role", "viewer"], { flags: [ROLE] });
    expect(requireChoice(args, ROLE, ROLES)).toBe("viewer");
  });
});

describe("requireOption and requireArg", () => {
  it("keep click's plain messages", () => {
    const user: FlagSpec = { name: "user", short: "u", type: "value" };
    const args = parseArgs(["create-key"], { flags: [user] });
    expect(usage(() => requireOption(args, user))).toBe("Missing option '--user' / '-u'.");
    expect(usage(() => requireArg(args, 0, "KEY_ID"))).toBe("Missing argument 'KEY_ID'.");
  });
});

describe("help rendering", () => {
  it("shows an optional value's metavar, and TEXT when none is declared, as click does", () => {
    const command: Command = {
      summary: "Probe.",
      spec: {
        flags: [
          { name: "agents-md", type: "optional", metavar: "[PATH]", help: "Export." },
          { name: "plain", type: "optional", help: "No metavar." },
        ],
      },
      run: async () => 0,
    };
    const help = renderHelp("kagura-memory probe", command);
    expect(help).toContain("      --agents-md [PATH]  Export.");
    expect(help).toContain("      --plain TEXT        No metavar.");
  });

  it("leaves a group without a description as it was", () => {
    const help = renderGroupHelp("kagura-memory g", "Group.", {
      a: { summary: "A.", spec: { flags: [] }, run: async () => 0 },
    });
    expect(help).toBe("Usage: kagura-memory g [OPTIONS] COMMAND [ARGS]...\n\n  Group.\n\nCommands:\n  a         A.");
  });
});
