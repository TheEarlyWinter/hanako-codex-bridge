import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { belongsToHanakoSession, consumeJsonLines } from "../bridge.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgePath = path.join(repoDir, "bridge.mjs");

function testEnvironment(overrides = {}) {
  return {
    ...process.env,
    HANAKO_SERVER_INFO: path.join(repoDir, "test", "does-not-exist", "server-info.json"),
    CODEX_EXECUTABLE: path.join(repoDir, "test", "does-not-exist", "codex.exe"),
    ...overrides,
  };
}

function createBridgeClient(overrides = {}) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: repoDir,
    env: testEnvironment(overrides),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });

  const waitFor = (predicate, timeoutMs = 3_000) => {
    const queuedIndex = messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("等待桥接器测试响应超时。"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  };

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const close = async () => {
    if (child.exitCode !== null) return;
    child.stdin.end();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(() => {
        child.kill();
        resolve();
      }, 2_000)),
    ]);
  };
  return { child, send, waitFor, close, messages };
}

async function initialize(client) {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const initialized = await client.waitFor((message) => message.id === 1);
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

test("JSONL chunks and Hanako session filtering are fail-closed", () => {
  const lines = [];
  let buffer = consumeJsonLines("", '{"type":"item","text":"first"}\n{"type":"item"', (line) => lines.push(JSON.parse(line)));
  buffer = consumeJsonLines(buffer, ',"text":"second"}\r\n', (line) => lines.push(JSON.parse(line)));
  assert.equal(buffer, "");
  assert.deepEqual(lines.map((item) => item.text), ["first", "second"]);

  const target = { sessionId: "session-a", sessionPath: "C:\\Users\\test\\a.jsonl" };
  assert.equal(belongsToHanakoSession({ sessionId: "session-a", sessionPath: "c:\\users\\TEST\\a.jsonl" }, target), true);
  assert.equal(belongsToHanakoSession({ sessionId: "session-b", sessionPath: target.sessionPath }, target), false);
  assert.equal(belongsToHanakoSession({ type: "text_delta", text: "unscoped" }, target), false);
});

test("MCP lifecycle negotiates supported versions and exposes four tools", async (t) => {
  const client = createBridgeClient();
  t.after(() => client.close());

  client.send({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
  const beforeInit = await client.waitFor((message) => message.id === 10);
  assert.equal(beforeInit.error.code, -32002);

  await initialize(client);
  client.send({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
  const listed = await client.waitFor((message) => message.id === 11);
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ["bridge_status", "codex_new_thread", "codex_task", "hanako_task"].sort(),
  );

  client.send({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "bridge_status", arguments: {} } });
  const statusResponse = await client.waitFor((message) => message.id === 12, 8_000);
  assert.equal(statusResponse.result.isError, false);
  const status = JSON.parse(statusResponse.result.content[0].text);
  assert.equal(status.hanakoServer, "unconfigured");
  assert.equal(status.codex, "unavailable");
  assert.equal(status.loopGuard, "clear");
  assert.equal(Object.hasOwn(status, "codexExecutable"), false);
  assert.equal(Object.hasOwn(status, "defaultCwd"), false);
});

test("unsupported protocol versions return a JSON-RPC error", async (t) => {
  const client = createBridgeClient();
  t.after(() => client.close());
  client.send({ jsonrpc: "2.0", id: 20, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  const response = await client.waitFor((message) => message.id === 20);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.data.supported.join(","), /2025-06-18/);
});

test("notifications/cancelled aborts an in-flight Hanako request without a tool response", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hanako-codex-bridge-test-"));
  let requestReceived;
  const received = new Promise((resolve) => { requestReceived = resolve; });
  const server = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/sessions/new-detached") {
      requestReceived();
      const timer = setTimeout(() => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ sessionPath: path.join(tempDir, "session.jsonl") }));
      }, 30_000);
      timer.unref();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const infoPath = path.join(tempDir, "server-info.json");
  await fs.writeFile(infoPath, JSON.stringify({ port, token: "test-token" }));

  const client = createBridgeClient({ HANAKO_SERVER_INFO: infoPath });
  let second;
  t.after(async () => {
    await second?.close();
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  await initialize(client);

  client.send({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "hanako_task", arguments: { task: "cancel me" } },
  });
  await received;

  second = createBridgeClient({ HANAKO_SERVER_INFO: infoPath });
  await initialize(second);
  second.send({
    jsonrpc: "2.0",
    id: 32,
    method: "tools/call",
    params: { name: "codex_task", arguments: { task: "must be blocked" } },
  });
  const blocked = await second.waitFor((message) => message.id === 32);
  assert.equal(blocked.result.isError, true);
  assert.match(blocked.result.content[0].text, /跨进程循环委派/);

  client.send({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 30, reason: "test cancellation" },
  });
  client.send({ jsonrpc: "2.0", id: 31, method: "ping", params: {} });
  const ping = await client.waitFor((message) => message.id === 31);
  assert.deepEqual(ping.result, {});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.messages.some((message) => message.id === 30), false);
});
