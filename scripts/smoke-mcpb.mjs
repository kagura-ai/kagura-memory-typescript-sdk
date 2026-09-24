import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { unzipSync } from "fflate";
import { VERSIONED_MANIFEST_SCHEMAS } from "@anthropic-ai/mcpb/schemas";

const root = fileURLToPath(new URL("../", import.meta.url));
// Keep build/test dependencies on a current Node while exercising the bundle
// with the exact minimum supported runtime (optional absolute executable path).
const nodePath = process.argv[2] ? resolve(process.argv[2]) : process.execPath;
const nodeVersion = execFileSync(nodePath, ["--version"], {
  encoding: "utf8", windowsHide: true,
}).trim();
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const bundleName = `kagura-memory-${pkg.version}.mcpb`;
const bytes = readFileSync(join(root, "artifacts", bundleName));
const digest = createHash("sha256").update(bytes).digest("hex");
assert.equal(
  readFileSync(join(root, "artifacts", `${bundleName}.sha256`), "utf8"),
  `${digest}  ${bundleName}\n`,
);
const files = unzipSync(bytes);
assert.deepEqual(Object.keys(files).sort(), [
  "LICENSE",
  "README.md",
  "manifest.json",
  "server/mcp.cjs",
]);
const manifest = JSON.parse(
  Buffer.from(files["manifest.json"]).toString("utf8"),
);
VERSIONED_MANIFEST_SCHEMAS[manifest.manifest_version].parse(manifest);
assert.equal(manifest.version, pkg.version);
const temporary = mkdtempSync(join(tmpdir(), "kagura-mcpb-smoke-"));
const extracted = join(temporary, "extension with spaces 日本語");
for (const [name, content] of Object.entries(files)) {
  const target = join(extracted, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const credentialsPath = join(temporary, "profile", "credentials.json");
let loginCount = 0;
let refreshCount = 0;
let sessions = 0;
let initializedCount = 0;
let rejectToken = false;
let expireSession = false;
let pendingLogin = false;
let pendingServerReply;
let serverFailure;
const requests = [];
const tool = {
  name: "future_tool",
  description: "Provided by Cloud",
  inputSchema: { type: "object", properties: {} },
};

const server = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const json = (value, status = 200, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/v1/oauth/device/authorize") {
      loginCount++;
      return json({
        device_code: "fake-device",
        user_code: "TEST-CODE",
        verification_uri: `${base}/device`,
        verification_uri_complete: `${base}/device?code=TEST-CODE`,
        expires_in: 600,
        interval: 1,
      });
    }
    if (req.url === "/api/v1/oauth/token/") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "refresh_token") {
        refreshCount++;
        assert.equal(form.get("refresh_token"), "fake-refresh");
      } else if (pendingLogin)
        return json({ error: "authorization_pending" }, 400);
      return json({
        access_token: `fake-access-${refreshCount}`,
        refresh_token: "fake-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "memory:read memory:write",
        workspace_id: "fake-workspace",
      });
    }
    assert.equal(req.url, "/mcp");
    assert.equal(req.method, "POST");
    const rpc = JSON.parse(body);
    requests.push(rpc);
    if (rejectToken) {
      rejectToken = false;
      res.writeHead(401).end();
      return;
    }
    assert.equal(
      req.headers.authorization,
      `Bearer fake-access-${refreshCount}`,
    );
    if (expireSession) {
      expireSession = false;
      res.writeHead(404).end();
      return;
    }
    if (rpc.method === "initialize") {
      assert.equal(req.headers["mcp-session-id"], undefined);
      sessions++;
      return json(
        {
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "mock-cloud", version: "1" },
          },
        },
        200,
        { "Mcp-Session-Id": `session-${sessions}` },
      );
    }
    assert.equal(req.headers["mcp-session-id"], `session-${sessions}`);
    assert.equal(req.headers["mcp-protocol-version"], "2025-06-18");
    if (rpc.method === "notifications/initialized") {
      initializedCount++;
      res.writeHead(202).end();
      return;
    }
    if (rpc.method === "tools/list")
      return json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [tool] } });
    if (rpc.method === "tools/call") {
      assert.equal(rpc.params.name, "future_tool");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { message: "日本語" } })}\r\n\r\n`,
      );
      // The proxy must keep reading stdin while this SSE response is open.
      pendingServerReply = () =>
        res.end(
          `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "未来のツール" }] } })}\n\n`,
        );
      res.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-ping", method: "ping" })}\n\n`,
      );
      return;
    }
    if (rpc.id === "server-ping" && "result" in rpc) {
      assert.ok(pendingServerReply);
      pendingServerReply();
      pendingServerReply = undefined;
      res.writeHead(202).end();
      return;
    }
    if (!Object.hasOwn(rpc, "id")) {
      res.writeHead(202).end();
      return;
    }
    return json({
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32601,
        message: "Unknown method",
        data: { original: rpc.method },
      },
    });
  } catch (error) {
    serverFailure = error;
    res.writeHead(500).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const children = new Set();

function launch(extra = []) {
  const args = manifest.server.mcp_config.args.map((arg) =>
    arg
      .replaceAll("${__dirname}", extracted)
      .replaceAll("${user_config.profile}", "desktop")
      .replaceAll("${user_config.server}", `${base}/mcp`),
  );
  // This executable stands in for the host's bundled Node. No PATH/global CLI.
  const child = spawn(
    nodePath,
    [...args, "--credentials", credentialsPath, "--no-browser", ...extra],
    {
      cwd: temporary,
      env: {
        ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "",
        // Early Node 18 emits an experimental-fetch warning. Application
        // diagnostics and the stdout/stderr hygiene assertions still apply.
        NODE_NO_WARNINGS: "1",
      },
      stdio: "pipe",
      windowsHide: true,
    },
  );
  children.add(child);
  const messages = [];
  const waiters = new Map();
  let stderr = "";
  let parseFailure;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const input = createInterface({ input: child.stdout });
  input.on("line", (line) => {
    try {
      const rpc = JSON.parse(line);
      assert.equal(rpc.jsonrpc, "2.0");
      messages.push(rpc);
      if (rpc.method === "ping")
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} }) + "\n",
        );
      if ("result" in rpc || "error" in rpc) waiters.get(rpc.id)?.(rpc);
    } catch (error) {
      parseFailure = error;
    }
  });
  const closed = once(child, "close").then(([code]) => {
    children.delete(child);
    return code;
  });
  const send = (rpc) => child.stdin.write(JSON.stringify(rpc) + "\n");
  const request = (rpc) =>
    new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(rpc.id);
        reject(new Error(`Timed out waiting for ${rpc.method}; ${stderr}`));
      }, 10_000);
      waiters.set(rpc.id, (reply) => {
        clearTimeout(timer);
        waiters.delete(rpc.id);
        resolveRequest(reply);
      });
      send(rpc);
    });
  return {
    child,
    messages,
    request,
    send,
    stderr: () => stderr,
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      try {
        assert.equal(await closed, 0);
      } finally {
        clearTimeout(timer);
      }
      if (parseFailure) throw parseFailure;
    },
  };
}

const init = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  },
};
try {
  const first = launch();
  assert.equal(
    (await first.request(init)).result.serverInfo.name,
    "mock-cloud",
  );
  first.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.deepEqual(
    (await first.request({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
      .result.tools,
    [tool],
  );
  assert.equal(loginCount, 1);
  assert.match(first.stderr(), /TEST-CODE/);
  assert.doesNotMatch(first.stderr(), /fake-access|fake-refresh|fake-device/);
  assert.equal(
    JSON.parse(readFileSync(credentialsPath, "utf8")).profiles.desktop
      .workspace_id,
    "fake-workspace",
  );

  rejectToken = true;
  assert.equal(
    (await first.request({ jsonrpc: "2.0", id: 2, method: "tools/list" }))
      .result.tools[0].name,
    "future_tool",
  );
  assert.equal(refreshCount, 1);
  expireSession = true;
  assert.ok(
    (await first.request({ jsonrpc: "2.0", id: 3, method: "tools/list" }))
      .result,
  );
  assert.equal(sessions, 2);
  assert.equal(initializedCount, 2);
  assert.equal(first.messages.filter((m) => m.id === 0).length, 1);
  assert.equal(
    (
      await first.request({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "future_tool", arguments: { query: "日本語" } },
      })
    ).result.content[0].text,
    "未来のツール",
  );
  assert.ok(first.messages.some((m) => m.method === "notifications/progress"));
  const error = await first.request({
    jsonrpc: "2.0",
    id: 5,
    method: "future/unknown",
  });
  assert.deepEqual(error.error, {
    code: -32601,
    message: "Unknown method",
    data: { original: "future/unknown" },
  });
  first.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 9 },
  });
  await first.request({ jsonrpc: "2.0", id: 6, method: "tools/list" });
  assert.ok(first.messages.every((m) => m.method || Object.hasOwn(m, "id")));
  await first.stop();

  const second = launch(["--no-login"]);
  assert.ok((await second.request(init)).result);
  assert.equal(loginCount, 1);
  assert.equal(second.stderr(), "");
  await second.stop();

  // A closed host must stop an outstanding first-login poll promptly.
  pendingLogin = true;
  const third = launch(["--profile", "cancelled-login"]);
  third.send(init);
  const until = Date.now() + 5000;
  while (!third.stderr().includes("TEST-CODE") && Date.now() < until)
    await new Promise((r) => setTimeout(r, 20));
  assert.match(third.stderr(), /TEST-CODE/);
  await third.stop();
  if (serverFailure) throw serverFailure;
  console.log(
    `MCPB smoke passed on ${process.platform}/${process.arch}, Node ${nodeVersion}\n${bundleName} sha256: ${digest}`,
  );
} finally {
  for (const child of children) {
    child.kill();
    await once(child, "close");
  }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  // Only remove the mkdtemp directory allocated by this test.
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  assert.ok(temporary.includes("kagura-mcpb-smoke-"));
  rmSync(temporary, { recursive: true, force: true });
}
