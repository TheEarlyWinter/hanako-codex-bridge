import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
const serverInfoPath = process.env.HANAKO_SERVER_INFO || path.join(
  process.env.USERPROFILE || process.env.HOME || bridgeDir,
  ".hanako",
  "server-info.json",
);
const defaultCwd = process.env.BRIDGE_DEFAULT_CWD || process.cwd();
const codexExecutableHint = process.env.CODEX_EXECUTABLE
  || (process.platform === "win32" ? "codex.exe" : "codex");
const codexTimeoutMs = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS || 20 * 60 * 1000);
const codexThreadTimeoutMs = Number(process.env.CODEX_THREAD_TIMEOUT_MS || codexTimeoutMs);
const hanakoTimeoutMs = Number(process.env.HANAKO_BRIDGE_TIMEOUT_MS || 15 * 60 * 1000);

function log(...values) {
  console.error("[hanako-codex-bridge]", ...values);
}

function safeText(value, limit = 8000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text || "").replaceAll("\u0000", "").slice(0, limit);
}

function getCodexEnvironment() {
  const profile = process.env.USERPROFILE || process.env.HOME;
  const env = { ...process.env };
  if (profile) {
    env.HOME = profile;
    env.CODEX_HOME = process.env.CODEX_HOME || path.join(profile, ".codex");
  }
  return env;
}

async function resolveCodexExecutable() {
  if (process.env.CODEX_EXECUTABLE) return process.env.CODEX_EXECUTABLE;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const binRoot = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    try {
      const entries = await fs.readdir(binRoot, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(binRoot, entry.name, "codex.exe"));
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          return candidate;
        } catch {
          // Try the next installed Codex bundle.
        }
      }
    } catch {
      // Fall back to PATH for nonstandard installations.
    }
  }
  return codexExecutableHint;
}

async function readHanakoInfo() {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(serverInfoPath, "utf8"));
  } catch {
    throw new Error("Hanako 本地服务信息不可读，请确认 Hanako 正在运行。");
  }

  const port = Number(
    parsed.port ?? parsed.serverPort ?? parsed.apiPort ?? parsed.server?.port,
  );
  const token = String(
    parsed.token ?? parsed.authToken ?? parsed.accessToken ?? parsed.auth?.token ?? "",
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) {
    throw new Error("Hanako 本地服务信息不完整，请重新启动 Hanako 后重试。");
  }
  return { port, token };
}

async function hanakoRequest(info, method, pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${info.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = raw;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      // Keep non-JSON responses as text for a compact, non-sensitive error.
    }
    if (!response.ok) {
      throw new Error(`Hanako HTTP ${response.status}: ${safeText(data, 1200)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveHanakoToolApproval(info, confirmation, action) {
  const confirmId = confirmation?.confirmId;
  if (!confirmId) return;
  try {
    await hanakoRequest(
      info,
      "POST",
      `/api/confirm/${encodeURIComponent(confirmId)}`,
      { action },
    );
  } catch (error) {
    log(`Hanako 工具确认处理失败：${safeText(error?.message || error, 1200)}`);
  }
}

function extractSession(data) {
  const candidates = [
    data,
    data?.data,
    data?.session,
    data?.result,
  ].filter(Boolean);
  for (const item of candidates) {
    const sessionPath = item.path || item.sessionPath || item.session?.path;
    const sessionId = item.sessionId || item.id || item.session?.id;
    if (sessionPath || sessionId) return { sessionPath, sessionId };
  }
  return { sessionPath: undefined, sessionId: undefined };
}

function extractMessageText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractMessageText).filter(Boolean).join("");
  }
  if (typeof value !== "object") return "";
  for (const key of ["text", "content", "message", "delta"]) {
    if (value[key] !== undefined) {
      const text = extractMessageText(value[key]);
      if (text) return text;
    }
  }
  for (const key of ["messages", "items", "data", "result"]) {
    if (value[key] !== undefined) {
      const text = extractMessageText(value[key]);
      if (text) return text;
    }
  }
  return "";
}

async function fallbackHanakoText(info, sessionPath) {
  if (!sessionPath) return "";
  const candidates = [
    `/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`,
    `/api/sessions/messages?sessionPath=${encodeURIComponent(sessionPath)}`,
  ];
  for (const endpoint of candidates) {
    try {
      const data = await hanakoRequest(info, "GET", endpoint);
      const text = extractMessageText(data);
      if (text) return text;
    } catch {
      // The stream is the primary protocol; older Hanako versions may not expose this route.
    }
  }
  return "";
}

async function runHanakoTask({ task, agentId = "hanako" }) {
  const info = await readHanakoInfo();
  const created = await hanakoRequest(info, "POST", "/api/sessions/new-detached", {
    agentId,
    // The caller explicitly requested full access for delegated Hanako work.
    permissionMode: "operate",
    launchContext: null,
    contextAttachments: [],
  });
  const { sessionPath, sessionId } = extractSession(created);
  if (!sessionPath && !sessionId) {
    throw new Error("Hanako 没有返回可用的任务会话。");
  }
  if (typeof WebSocket !== "function") {
    throw new Error("当前 Node.js 不支持 WebSocket，无法连接 Hanako 会话。");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let text = "";
    let socket;
    const timer = setTimeout(() => finish(new Error("等待 Hanako 响应超时。")), hanakoTimeoutMs);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Ignore close errors after a completed turn.
      }
      if (error) reject(error);
      else resolve(result ?? text.trim());
    };

    try {
      socket = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`);
    } catch (error) {
      finish(new Error(`无法建立 Hanako WebSocket：${safeText(error?.message || error, 1200)}`));
      return;
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "ui_context_register", supported: true, version: 1 }));
      socket.send(JSON.stringify({
        type: "prompt",
        text: task,
        sessionId,
        sessionPath,
        displayMessage: { text: task },
      }));
    });

    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const type = message?.type || message?.event;
      if (type === "text_delta") {
        text += String(message.delta ?? message.text ?? "");
        return;
      }
      if (type === "session_assistant_message" || type === "assistant_message") {
        const role = message.message?.role || message.role;
        if (!role || role === "assistant") {
          const assistantText = extractMessageText(message.message ?? message.content ?? message.text);
          if (assistantText && !text.includes(assistantText)) text += assistantText;
        }
        return;
      }
      if (type === "content_block" || type === "session_confirmation") {
        const block = type === "content_block"
          ? message.block
          : (message.request || message);
        if (block?.type === "session_confirmation" && block.kind === "tool_action_approval") {
          // Full-access mode intentionally confirms any approval raised by
          // the detached Hanako session.
          void resolveHanakoToolApproval(info, block, "confirmed");
        }
        return;
      }
      if (type === "error" || type === "stream_error") {
        finish(new Error(`Hanako 任务失败：${safeText(message.message ?? message.error ?? message, 2000)}`));
        return;
      }
      if (type === "stream_turn_end" || type === "turn_end") {
        if (text.trim()) {
          finish(null, text.trim());
        }
        // Hanako can emit a turn-end event after an intermediate tool round and
        // continue the same delegated task. Wait for a real assistant message;
        // the overall timeout remains the final guard.
      }
    });

    socket.addEventListener("error", () => {
      finish(new Error("Hanako WebSocket 连接失败。"));
    });
    socket.addEventListener("close", () => {
      if (!settled && text.trim()) finish(null, text.trim());
    });
  });
}

function parseCodexEvent(line, state) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const candidates = [
    event?.item,
    event?.result,
    event,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.type === "agent_message" || candidate.type === "assistant_message") {
      const value = candidate.text ?? candidate.message ?? candidate.content;
      if (typeof value === "string" && value.trim()) state.lastMessage = value.trim();
    }
  }
}

async function runCodexTask({ task, cwd = defaultCwd }) {
  const resolvedCwd = path.resolve(cwd);
  const env = getCodexEnvironment();
  const executable = await resolveCodexExecutable();
  const args = [
    "exec",
    "--ephemeral",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--cd",
    resolvedCwd,
    "-",
  ];

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        cwd: resolvedCwd,
        env,
        windowsHide: true,
        shell: process.platform === "win32" && /\.cmd$/i.test(executable),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new Error(`无法启动 Codex：${safeText(error?.message || error, 1200)}`));
      return;
    }

    const state = { lastMessage: "" };
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill();
      reject(new Error("等待 Codex 响应超时。"));
    }, codexTimeoutMs);

    child.stdout.on("data", (chunk) => {
      const lines = String(chunk).split(/\r?\n/);
      for (const line of lines) if (line.trim()) parseCodexEvent(line, state);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 Codex：${safeText(error?.message || error, 1200)}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.replace(/\r?\n/g, " ").trim();
        reject(new Error(`Codex 任务失败（退出码 ${code}）${detail ? `：${safeText(detail, 1800)}` : "。"}`));
        return;
      }
      if (!state.lastMessage) {
        reject(new Error("Codex 已结束，但没有返回文字结果。"));
        return;
      }
      resolve(state.lastMessage);
    });
    child.stdin.end([
      "你正在接收来自 Hanako 的委派任务。",
      "当前是用户明确启用的完全访问模式；可以按任务需要读写文件、执行命令并访问网络。",
      "返回简洁、可直接转交给 Hanako 的结果。",
      "如果确实需要 Hanako 的视角，可以调用 hanako_task 工具；不要循环委派。",
      "",
      "委派任务：",
      task,
    ].join("\n"));
  });
}

function extractCodexAgentText(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "agentMessage" || item.type === "agent_message") {
    return typeof item.text === "string" ? item.text.trim() : "";
  }
  if (item.item && typeof item.item === "object") return extractCodexAgentText(item.item);
  return "";
}

function extractCodexTurnText(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const messages = items.map(extractCodexAgentText).filter(Boolean);
  return messages.at(-1) || "";
}

async function openCodexAppServer() {
  const executable = await resolveCodexExecutable();
  let child;
  try {
    child = spawn(executable, ["app-server", "--stdio"], {
      cwd: defaultCwd,
      env: getCodexEnvironment(),
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(executable),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`无法启动 Codex app-server：${safeText(error?.message || error, 1200)}`);
  }

  let buffer = "";
  let nextId = 1;
  let closed = false;
  let stderr = "";
  const pending = new Map();
  const eventListeners = new Set();

  const rejectPending = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const handleLine = (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`Codex app-server 返回了无法解析的 JSON：${safeText(line, 1200)}`);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(safeText(message.error.message || message.error, 2000)));
      else entry.resolve(message.result);
      return;
    }
    for (const listener of eventListeners) listener(message);
  };

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 6000) stderr = stderr.slice(-6000);
  });
  child.on("error", (error) => {
    if (!closed) rejectPending(new Error(`Codex app-server 失败：${safeText(error?.message || error, 1600)}`));
  });
  child.on("close", (code) => {
    closed = true;
    const detail = stderr.replace(/\r?\n/g, " ").trim();
    rejectPending(new Error(`Codex app-server 已退出（退出码 ${code}）${detail ? `：${safeText(detail, 2200)}` : "。"}`));
  });

  const request = (method, params, timeoutMs = codexThreadTimeoutMs) => new Promise((resolve, reject) => {
    if (closed) {
      reject(new Error("Codex app-server 已关闭。"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex app-server 请求超时：${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`无法写入 Codex app-server：${safeText(error?.message || error, 1200)}`));
    }
  });

  const notify = (method, params) => {
    if (closed) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      child.stdin.end();
    } catch {
      // Ignore shutdown races.
    }
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill();
        } catch {
          // Ignore a process that already exited.
        }
      }
    }, 1500).unref();
  };

  return {
    request,
    notify,
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    close,
  };
}

async function runCodexNewThread({ task, cwd = defaultCwd, model, effort }) {
  const resolvedCwd = path.resolve(cwd);
  const client = await openCodexAppServer();
  let threadId = "";
  let finalText = "";
  let finished = false;

  const finishedPromise = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      if (error) reject(error);
      else resolve(value);
    };

    var unsubscribe;
    unsubscribe = client.onEvent((message) => {
      const method = String(message?.method || "");
      const params = message?.params || {};
      if (method === "item/completed" || method === "item_completed") {
        const text = extractCodexAgentText(params.item || params);
        if (text) finalText = text;
        return;
      }
      if (method === "turn/completed" || method === "turn_completed") {
        if (params.threadId && threadId && params.threadId !== threadId) return;
        const turn = params.turn || params;
        const text = extractCodexTurnText(turn);
        if (text) finalText = text;
        if (turn.status === "failed" || turn.error) {
          finish(new Error(turn.error?.message || "Codex 新任务执行失败。"));
        } else if (turn.status === "interrupted") {
          finish(new Error("Codex 新任务被中断。"));
        } else {
          finish(null, finalText);
        }
      }
    });
  });

  try {
    await client.request("initialize", {
      clientInfo: {
        name: "hanako-codex-bridge",
        title: "Hanako → Codex thread bridge",
        version: "0.2.0",
      },
      capabilities: {},
    });
    client.notify("initialized", {});

    const threadParams = {
      cwd: resolvedCwd,
      ephemeral: false,
      threadSource: "hanako-mcp",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    };
    if (model) threadParams.model = model;
    const started = await client.request("thread/start", threadParams);
    threadId = started?.thread?.id || started?.threadId || "";
    if (!threadId) throw new Error("Codex app-server 没有返回新任务 ID。 ");

    const turnParams = {
      threadId,
      input: [{ type: "text", text: task }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    if (effort) turnParams.effort = effort;
    await client.request("turn/start", turnParams);
    const result = await finishedPromise;
    return JSON.stringify({
      threadId,
      status: "completed",
      result: result || finalText || "Codex 已完成任务，但没有返回文字结果。",
      cwd: resolvedCwd,
      persistent: true,
    }, null, 2);
  } finally {
    client.close();
  }
}

async function bridgeStatus() {
  let infoStatus = "unavailable";
  try {
    const info = await readHanakoInfo();
    infoStatus = `available:${info.port}`;
  } catch {
    // Do not include the token or the raw path in status output.
  }
  const executable = await resolveCodexExecutable();
  return JSON.stringify({
    bridge: "hanako-codex-bridge",
    mode: "local-two-way-full-access",
    hanakoServer: infoStatus,
    codexExecutable: executable,
    defaultCwd,
    node: process.version,
  }, null, 2);
}

const toolDefinitions = [
  {
    name: "codex_task",
    description: "以完全访问模式把任务委派给本机 Codex，并返回 Codex 的最终文字结果。",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "要交给 Codex 的任务。" },
        cwd: { type: "string", description: "可选：Codex 读取任务上下文时使用的本地目录。" },
      },
      required: ["task"],
    },
  },
  {
    name: "codex_new_thread",
    description: "通过 Codex app-server 创建一个持久的新 Codex 对话，并把任务作为首轮消息发送；返回 threadId 和首轮结果。",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "新 Codex 对话的首轮任务。" },
        cwd: { type: "string", description: "可选：新 Codex 对话使用的本地工作目录。" },
        model: { type: "string", description: "可选：Codex 模型 ID。" },
        effort: { type: "string", description: "可选：Codex 推理强度。" },
      },
      required: ["task"],
    },
  },
  {
    name: "hanako_task",
    description: "以完全访问模式把任务委派给本机 Hanako，并返回 Hanako 的最终文字结果。",
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task: { type: "string", description: "要交给 Hanako 的任务。" },
        agentId: { type: "string", description: "可选：Hanako agent id，默认使用 hanako。" },
      },
      required: ["task"],
    },
  },
  {
    name: "bridge_status",
    description: "查看本机 Hanako-Codex 桥接器状态；不会返回任何令牌。",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function errorResponse(id, message) {
  response(id, {
    content: [{ type: "text", text: safeText(message, 4000) }],
    isError: true,
  });
}

async function handleRequest(request) {
  const id = request.id;
  if (request.method === "initialize") {
    response(id, {
      protocolVersion: request.params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hanako-codex-bridge", version: "0.2.0" },
      instructions: "Local two-way Hanako/Codex task bridge. Use codex_new_thread when Hanako must create a persistent Codex conversation. Delegated tasks run with full local access by explicit user request.",
    });
    return;
  }
  if (request.method === "notifications/initialized" || request.method === "ping") {
    if (request.method === "ping" && id !== undefined) response(id, {});
    return;
  }
  if (request.method === "tools/list") {
    response(id, { tools: toolDefinitions });
    return;
  }
  if (request.method !== "tools/call") {
    errorResponse(id, `不支持的 MCP 方法：${request.method}`);
    return;
  }

  const name = request.params?.name;
  const args = request.params?.arguments || {};
  try {
    let result;
    if (name === "bridge_status") result = await bridgeStatus();
    else if (name === "codex_task") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("codex_task 需要非空 task。");
      result = await runCodexTask({ task: args.task, cwd: args.cwd });
    } else if (name === "codex_new_thread") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("codex_new_thread 需要非空 task。");
      result = await runCodexNewThread({
        task: args.task,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
      });
    } else if (name === "hanako_task") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("hanako_task 需要非空 task。");
      result = await runHanakoTask({ task: args.task, agentId: args.agentId || "hanako" });
    } else {
      throw new Error(`未知工具：${name}`);
    }
    response(id, { content: [{ type: "text", text: String(result) }], isError: false });
  } catch (error) {
    errorResponse(id, error?.message || error);
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    log("收到无法解析的 MCP 输入。");
    return;
  }
  void handleRequest(request).catch((error) => errorResponse(request.id, error?.message || error));
});

input.on("close", () => process.exit(0));
