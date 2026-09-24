import { runProxy } from "./mcp/run.js";
import { safeError } from "./mcp/errors.js";

const controller = new AbortController();
const abort = (): void => controller.abort();
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
process.stdout.on("error", abort);

runProxy(process.argv.slice(2), {
  input: process.stdin,
  output: (line) => {
    process.stdout.write(line);
  },
  error: (line) => {
    process.stderr.write(line);
  },
  signal: controller.signal,
})
  .then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    },
  )
  .finally(() => {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    process.stdin.destroy();
  });
