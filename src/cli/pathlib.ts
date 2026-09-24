/**
 * `pathlib` string forms the CLI prints, shared by `guardrails digest
 * --out` and the `setup` AGENTS.md export so both name a path as the
 * Python CLI does.
 */

import * as path from "node:path";

/**
 * `str(pathlib.Path(raw))`: the path the Python CLI writes to and prints.
 *
 * Lexical only: repeated separators and `.` segments go, and so does a
 * trailing separator; `..` stays, nothing is made absolute and `~` is not
 * expanded. On POSIX exactly two leading slashes are kept, as pathlib
 * keeps them. On Windows `/` reads as `\`, and the drive or UNC share is
 * kept as written.
 *
 * `p` is for tests: `path.win32` checks the Windows rules on any OS.
 */
export function pathlibString(raw: string, p: path.PlatformPath = path): string {
  let root: string;
  let rest: string;
  if (p.sep === "\\") {
    const text = raw.split("/").join("\\");
    root = p.parse(text).root;
    rest = text.slice(root.length);
    // A bare share, `\\server\share`, is a root: pathlib ends it with `\`
    // (not a `\\?\` or `\\.\` device path).
    const share = /^\\\\([^\\]+)\\[^\\]+$/.exec(root);
    if (share !== null && !"?.".includes(share[1]!)) root += "\\";
  } else {
    root = raw.startsWith("//") && !raw.startsWith("///") ? "//" : raw.startsWith("/") ? "/" : "";
    rest = raw.slice(root.length);
  }
  const parts = rest.split(p.sep).filter((part) => part !== "" && part !== ".");
  return root + parts.join(p.sep) || ".";
}
