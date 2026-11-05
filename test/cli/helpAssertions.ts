import helpOracle from "./pythonHelp044.json" with { type: "json" };

/** Python help with the executable name substituted before Click wraps it. */
export function pythonHelp(path: string): string {
  const page = helpOracle.find(page => page.path === path);
  if (!page) throw new Error(`No Python help oracle for ${path}`);
  return page.binStdout.trimEnd();
}

/** Read wrapped option rows for tests that check wording, not layout. */
export function optionRows(help: string): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of (help.split("Options:\n")[1] ?? "").split("\n")) {
    if (/^ {2}-/.test(line)) {
      const [label, ...description] = line.trim().split(/ {2,}/);
      rows.push([label!, description.join("  ")]);
    } else if (/^ {4,}\S/.test(line) && rows.length) {
      const row = rows.at(-1)!;
      row[1] += (row[1].endsWith("-") || !row[1] ? "" : " ") + line.trim();
    }
  }
  return rows;
}

export function optionLines(help: string): string[] {
  return optionRows(help).map(([label, text]) => `  ${label}  ${text}`);
}

export function prose(text: string): string {
  return text.replace(/-\n\s+/g, "-").replace(/\s+/g, " ").trim();
}
