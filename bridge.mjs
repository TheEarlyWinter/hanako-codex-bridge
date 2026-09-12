import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync, promises as fs, readFileSync, unlinkSync, writeSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
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
function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

const codexTimeoutMs = positiveNumber(process.env.CODEX_BRIDGE_TIMEOUT_MS, 20 * 60 * 1000);
const codexThreadTimeoutMs = positiveNumber(process.env.CODEX_THREAD_TIMEOUT_MS, codexTimeoutMs);
const hanakoTimeoutMs = positiveNumber(process.env.HANAKO_BRIDGE_TIMEOUT_MS, 15 * 60 * 1000);
const bridgeProtocolVersion = "2025-06-18";
const supportedProtocolVersions = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const maxActiveDelegations = Math.max(1, Math.floor(positiveNumber(process.env.BRIDGE_MAX_CONCURRENT, 4)));
const maxDelegationHops = nonNegativeInteger(process.env.BRIDGE_MAX_HOPS, 1);
const delegationHop = nonNegativeInteger(process.env.HANAKO_CODEX_BRIDGE_HOP, 0);
const reentryDisabled = process.env.HANAKO_CODEX_BRIDGE_NO_REENTRY === "1";
const activeDelegations = new Map();
const activeRequests = new Map();
const globalLoopGuardPath = path.join(os.tmpdir(), "hanako-codex-bridge-hanako.lock");
let localGlobalGuardToken = "";

function abortError(reason = "操作已取消。") {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason?.message || "操作已取消。");
}

function sameSessionPath(left, right) {
  if (!left || !right) return false;
  return path.normalize(String(left)).toLowerCase() === path.normalize(String(right)).toLowerCase();
}

function collectHanakoSessionRefs(value, refs = { ids: new Set(), paths: new Set() }, depth = 0) {
  if (!value || depth > 5) return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectHanakoSessionRefs(item, refs, depth + 1);
    return refs;
  }
  if (typeof value !== "object") return refs;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "sessionId" || key === "session_id") && typeof item === "string" && item) {
      refs.ids.add(item);
    } else if ((key === "sessionPath" || key === "session_path") && typeof item === "string" && item) {
      refs.paths.add(item);
    } else if (["session", "message", "request", "block", "payload", "data", "result"].includes(key)) {
      collectHanakoSessionRefs(item, refs, depth + 1);
    }
  }
  return refs;
}

function belongsToHanakoSession(message, target) {
  if (!target?.sessionId && !target?.sessionPath) return false;
  const refs = collectHanakoSessionRefs(message);
  if (!refs.ids.size && !refs.paths.size) return false;
  if (refs.ids.size && target.sessionId && !refs.ids.has(target.sessionId)) return false;
  if (refs.paths.size && target.sessionPath && ![...refs.paths].some((value) => sameSessionPath(value, target.sessionPath))) {
    return false;
  }
  return Boolean(
    (target.sessionId && refs.ids.has(target.sessionId))
      || (target.sessionPath && [...refs.paths].some((value) => sameSessionPath(value, target.sessionPath))),
  );
}

function consumeJsonLines(buffer, chunk, onLine) {
  let pending = `${buffer || ""}${String(chunk ?? "")}`;
  let newlineIndex;
  while ((newlineIndex = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
    pending = pending.slice(newlineIndex + 1);
    if (line.trim()) onLine(line);
  }
  return pending;
}

function delegationKey(kind, task, cwd) {
  return createHash("sha256")
    .update(`${kind}\n${path.resolve(cwd || defaultCwd)}\n${String(task).trim()}`)
    .digest("hex");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readGlobalLoopGuard() {
  try {
    const record = JSON.parse(readFileSync(globalLoopGuardPath, "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return { malformed: true };
  }
}

function globalLoopGuardIsActive() {
  if (localGlobalGuardToken) return true;
  const record = readGlobalLoopGuard();
  if (!record) return false;
  if (record.malformed || isProcessAlive(Number(record.pid))) return true;
  try {
    unlinkSync(globalLoopGuardPath);
  } catch {
    // A concurrent process may have already removed a stale lease.
  }
  return false;
}

function acquireGlobalLoopGuard() {
  if (localGlobalGuardToken) {
    throw new Error("当前桥接进程已经有 Hanako detached 委派，已拒绝嵌套委派。");
  }
  const token = createHash("sha256")
    .update(`${process.pid}\n${Date.now()}\n${Math.random()}`)
    .digest("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(globalLoopGuardPath, "wx");
      const record = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token });
      writeSync(descriptor, record, null, "utf8");
      closeSync(descriptor);
      localGlobalGuardToken = token;
      return () => {
        if (localGlobalGuardToken !== token) return;
        localGlobalGuardToken = "";
        try {
          const current = readGlobalLoopGuard();
          if (current?.token === token) unlinkSync(globalLoopGuardPath);
        } catch {
          // Ignore shutdown races; stale leases are recovered on the next call.
        }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { /* Ignore a failed lock write. */ }
        try { unlinkSync(globalLoopGuardPath); } catch { /* Ignore cleanup races. */ }
      }
      if (error?.code !== "EEXIST") throw error;
      const current = readGlobalLoopGuard();
      if (current?.malformed || isProcessAlive(Number(current?.pid))) {
        throw new Error("为防止跨进程循环委派，本机已有 Hanako detached 委派正在执行。");
      }
      try { unlinkSync(globalLoopGuardPath); } catch { /* Retry will report a live race if needed. */ }
    }
  }
  throw new Error("无法取得本机委派保护租约，请稍后重试。");
}

function beginDelegation(kind, task, cwd) {
  if (reentryDisabled) {
    throw new Error("为防止循环委派，当前下游 Codex 任务不能再次调用 Hanako-Codex 桥接器。");
  }
  if (delegationHop > maxDelegationHops) {
    throw new Error("已达到桥接器允许的最大委派层数，已拒绝继续委派。");
  }
  if (localGlobalGuardToken && kind !== "hanako") {
    throw new Error("为防止循环委派，Hanako detached 委派期间不能再启动其他桥接委派。");
  }
  if (!localGlobalGuardToken && globalLoopGuardIsActive()) {
    throw new Error("为防止跨进程循环委派，本机已有 Hanako detached 委派正在执行。");
  }
  if (activeDelegations.size >= maxActiveDelegations) {
    throw new Error("桥接器当前委派任务数已达上限，请等待现有任务完成。");
  }
  const key = delegationKey(kind, task, cwd);
  if (activeDelegations.has(key)) {
    throw new Error("相同委派任务正在执行，已拒绝重复启动。");
  }
  activeDelegations.set(key, { kind, startedAt: Date.now() });
  let guardRelease;
  try {
    if (kind === "hanako") guardRelease = acquireGlobalLoopGuard();
  } catch (error) {
    activeDelegations.delete(key);
    throw error;
  }
  return () => {
    guardRelease?.();
    activeDelegations.delete(key);
  };
}

function getDelegatedCodexEnvironment() {
  const env = getCodexEnvironment();
  env.HANAKO_CODEX_BRIDGE_HOP = String(delegationHop + 1);
  env.HANAKO_CODEX_BRIDGE_NO_REENTRY = "1";
  return env;
}

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

async function hanakoRequest(info, method, pathname, body, { signal } = {}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
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
  } catch (error) {
    if (timedOut) throw new Error("Hanako HTTP 请求超时。");
    if (signal?.aborted) throw abortError(signal.reason?.message || "操作已取消。");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function resolveHanakoToolApproval(info, confirmation, action, target, { signal, source } = {}) {
  const confirmId = confirmation?.confirmId;
  if (!confirmId) return;
  if (!belongsToHanakoSession(source || confirmation, target)) {
    log("忽略了不属于当前 Hanako 会话的工具确认请求。");
    return;
  }
  try {
    await hanakoRequest(
      info,
      "POST",
      `/api/confirm/${encodeURIComponent(confirmId)}`,
      { action },
      { signal },
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

async function readHanakoSessionMessages(info, sessionPath, { signal } = {}) {
  if (!sessionPath) return null;
  throwIfAborted(signal);
  try {
    // `path` is the canonical Hanako locator. Do not fall back to an
    // unscoped/current-session query: that could return another conversation.
    return await hanakoRequest(
      info,
      "GET",
      `/api/sessions/messages?path=${encodeURIComponent(sessionPath)}`,
      undefined,
      { signal },
    );
  } catch (error) {
    // The stream is the primary protocol; older Hanako versions may not expose this route.
    if (signal?.aborted) throw error;
    return null;
  }
}

function extractLatestHanakoAssistantText(data, task) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const latestUser = messages.filter((message) => message?.role === "user").at(-1);
  if (task && latestUser?.content !== task) return "";
  const assistant = messages
    .filter((message) => message?.role === "assistant" && typeof message.content === "string" && message.content.trim())
    .at(-1);
  return assistant?.content?.trim() || "";
}

async function fallbackHanakoText(info, sessionPath, task, { signal } = {}) {
  const data = await readHanakoSessionMessages(info, sessionPath, { signal });
  return extractLatestHanakoAssistantText(data, task);
}

function appendHanakoText(current, value) {
  const addition = String(value ?? "");
  if (!addition) return current;
  if (!current || current === addition || current.endsWith(addition) || current.includes(addition)) {
    return current || addition;
  }
  if (addition.startsWith(current)) return addition;
  return current + addition;
}

function isHanakoTerminalMessage(message) {
  const type = message?.type || message?.event;
  const turn = message?.turn || message?.message?.turn;
  return message?.final === true
    || message?.done === true
    || message?.completed === true
    || message?.phase === "final_answer"
    || message?.message?.phase === "final_answer"
    || message?.status === "completed"
    || message?.status === "complete"
    || message?.status === "done"
    || turn?.status === "completed"
    || turn?.status === "complete"
    || turn?.status === "done"
    || message?.isStreaming === false
    || type === "turn_end";
}

async function runHanakoTask({ task, agentId = "hanako", signal }) {
  const release = beginDelegation("hanako", task, defaultCwd);
  try {
    throwIfAborted(signal);
    const info = await readHanakoInfo();
    const created = await hanakoRequest(info, "POST", "/api/sessions/new-detached", {
      agentId,
      // The caller explicitly requested full access for delegated Hanako work.
      permissionMode: "operate",
      launchContext: null,
      contextAttachments: [],
    }, { signal });
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
      let pendingFinish;
      let pollTimer;
      let pollInFlight = false;
      let stableRevision = null;
      let stableText = "";
      let stableSince = 0;
      const target = { sessionPath, sessionId };
      const timer = setTimeout(() => finish(new Error("等待 Hanako 响应超时。")), hanakoTimeoutMs);

      const clearPendingFinish = () => {
        if (pendingFinish) {
          clearTimeout(pendingFinish);
          pendingFinish = undefined;
        }
      };

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearPendingFinish();
        if (pollTimer) clearInterval(pollTimer);
        signal?.removeEventListener("abort", onAbort);
        try {
          socket?.close();
        } catch {
          // Ignore close errors after a completed turn.
        }
        if (error) reject(error);
        else resolve(result ?? text.trim());
      };

      const onAbort = () => finish(abortError(signal.reason?.message || "操作已取消。"));
      signal?.addEventListener("abort", onAbort, { once: true });

      const finishFromFallback = async () => {
        if (settled) return;
        try {
          const fallback = await fallbackHanakoText(info, sessionPath, task, { signal });
          if (fallback.trim()) {
            finish(null, fallback.trim());
          } else if (text.trim()) {
            finish(null, text.trim());
          }
        } catch (error) {
          if (signal?.aborted) finish(abortError(signal.reason?.message || "操作已取消。"));
          else if (text.trim()) finish(null, text.trim());
        }
      };

      const pollHanakoResult = async () => {
        if (settled || pollInFlight) return;
        pollInFlight = true;
        try {
          const data = await readHanakoSessionMessages(info, sessionPath, { signal });
          const candidate = extractLatestHanakoAssistantText(data, task);
          if (!candidate) {
            stableRevision = null;
            stableText = "";
            stableSince = 0;
            return;
          }
          const revision = String(data?.revision ?? "");
          if (candidate !== stableText || revision !== stableRevision) {
            stableText = candidate;
            stableRevision = revision;
            stableSince = Date.now();
            return;
          }
          if (Date.now() - stableSince >= 1_000) finish(null, candidate);
        } catch (error) {
          if (signal?.aborted) finish(abortError(signal.reason?.message || "操作已取消。"));
        } finally {
          pollInFlight = false;
        }
      };

      const scheduleFinish = () => {
        clearPendingFinish();
        pendingFinish = setTimeout(() => {
          void finishFromFallback();
        }, 250);
      };

      try {
        socket = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(info.token)}`);
      } catch (error) {
        finish(new Error(`无法建立 Hanako WebSocket：${safeText(error?.message || error, 1200)}`));
        return;
      }
      pollTimer = setInterval(() => void pollHanakoResult(), 1_000);
      void pollHanakoResult();

      socket.addEventListener("open", () => {
        try {
          throwIfAborted(signal);
          socket.send(JSON.stringify({ type: "ui_context_register", supported: true, version: 1 }));
          socket.send(JSON.stringify({
            type: "prompt",
            text: task,
            sessionId,
            sessionPath,
            displayMessage: { text: task },
          }));
        } catch (error) {
          finish(error?.name === "AbortError" ? error : new Error(`无法发送 Hanako 任务：${safeText(error?.message || error, 1200)}`));
        }
      });

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        // /ws is a global stream. Drop every event that is not explicitly tied
        // to the detached session we just created; missing identity fails closed.
        if (!belongsToHanakoSession(message, target)) return;

        const type = message?.type || message?.event;
        if (type === "text_delta") {
          text = appendHanakoText(text, message.delta ?? message.text);
          return;
        }
        if (type === "session_assistant_message" || type === "assistant_message") {
          const role = message.message?.role || message.role;
          if (!role || role === "assistant") {
            const assistantText = extractMessageText(message.message ?? message.content ?? message.text);
            text = appendHanakoText(text, assistantText);
            if (assistantText && isHanakoTerminalMessage(message)) finish(null, text.trim());
          }
          return;
        }
        if (type === "content_block" || type === "session_confirmation") {
          const block = type === "content_block"
            ? message.block
            : (message.request || message);
          if (block?.type === "session_confirmation" && block.kind === "tool_action_approval") {
            // Full-access mode intentionally confirms approvals from this
            // detached Hanako session only.
            void resolveHanakoToolApproval(info, block, "confirmed", target, { signal, source: message });
          }
          return;
        }
        if (type === "error" || type === "stream_error") {
          finish(new Error(`Hanako 任务失败：${safeText(message.message ?? message.error ?? message, 2000)}`));
          return;
        }
        if (type === "stream_turn_end") {
          // This event can mark an intermediate tool round. Never return its
          // accumulated assistant text by itself.
          if (isHanakoTerminalMessage(message) && text.trim()) finish(null, text.trim());
          return;
        }
        if (type === "turn_end") {
          if (message.final === false || message.intermediate === true) return;
          if (text.trim() && isHanakoTerminalMessage(message)) scheduleFinish();
          else void pollHanakoResult();
        }
      });

      socket.addEventListener("error", () => {
        void pollHanakoResult();
      });
      socket.addEventListener("close", () => {
        if (!settled) void pollHanakoResult();
      });
    });
  } finally {
    release();
  }
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

async function runCodexTask({ task, cwd = defaultCwd, signal }) {
  const resolvedCwd = path.resolve(cwd);
  const release = beginDelegation("codex", task, resolvedCwd);
  try {
    throwIfAborted(signal);
    const env = getDelegatedCodexEnvironment();
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
      let stdoutBuffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
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
      let timedOut = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error && child && !child.killed) {
          try {
            child.kill();
          } catch {
            // Ignore shutdown races.
          }
        }
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(abortError(signal.reason?.message || "操作已取消。"));
      const timer = setTimeout(() => {
        timedOut = true;
        finish(new Error("等待 Codex 响应超时。"));
      }, codexTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      child.stdout.on("data", (chunk) => {
        stdoutBuffer = consumeJsonLines(stdoutBuffer, stdoutDecoder.write(chunk), (line) => parseCodexEvent(line, state));
      });
      child.stderr.on("data", (chunk) => {
        stderr += stderrDecoder.write(chunk);
        if (stderr.length > 5000) stderr = stderr.slice(-5000);
      });
      child.stdin.on("error", (error) => {
        if (!settled) finish(new Error(`无法写入 Codex 任务：${safeText(error?.message || error, 1200)}`));
      });
      child.on("error", (error) => {
        if (settled) return;
        finish(new Error(`无法启动 Codex：${safeText(error?.message || error, 1200)}`));
      });
      child.on("close", (code) => {
        if (settled) return;
        stdoutBuffer = consumeJsonLines(stdoutBuffer, stdoutDecoder.end(), (line) => parseCodexEvent(line, state));
        stderr += stderrDecoder.end();
        if (stdoutBuffer.trim()) parseCodexEvent(stdoutBuffer.trim(), state);
        if (timedOut) return;
        if (code !== 0) {
          const detail = stderr.replace(/\r?\n/g, " ").trim();
          finish(new Error(`Codex 任务失败（退出码 ${code}）${detail ? `：${safeText(detail, 1800)}` : "。"}`));
          return;
        }
        if (!state.lastMessage) {
          finish(new Error("Codex 已结束，但没有返回文字结果。"));
          return;
        }
        finish(null, state.lastMessage);
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
  } finally {
    release();
  }
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
      env: getDelegatedCodexEnvironment(),
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
  let closing = false;
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const pending = new Map();
  const eventListeners = new Set();
  const closeListeners = new Set();

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
    for (const listener of eventListeners) {
      try {
        listener(message);
      } catch (listenerError) {
        log(`Codex app-server 事件监听器失败：${safeText(listenerError?.message || listenerError, 1200)}`);
      }
    }
  };

  child.stdout.on("data", (chunk) => {
    buffer += stdoutDecoder.write(chunk);
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += stderrDecoder.write(chunk);
    if (stderr.length > 6000) stderr = stderr.slice(-6000);
  });
  const markClosed = (error) => {
    if (closed) return;
    closed = true;
    const reason = error || new Error("Codex app-server 已关闭。");
    rejectPending(reason);
    for (const listener of closeListeners) {
      try {
        listener(reason);
      } catch (listenerError) {
        log(`Codex app-server 关闭监听器失败：${safeText(listenerError?.message || listenerError, 1200)}`);
      }
    }
    closeListeners.clear();
  };

  child.on("error", (error) => {
    markClosed(new Error(`Codex app-server 失败：${safeText(error?.message || error, 1600)}`));
  });
  child.on("close", (code) => {
    buffer += stdoutDecoder.end();
    if (buffer.trim()) handleLine(buffer.trim());
    stderr += stderrDecoder.end();
    const detail = stderr.replace(/\r?\n/g, " ").trim();
    markClosed(new Error(`Codex app-server 已退出（退出码 ${code}）${detail ? `：${safeText(detail, 2200)}` : "。"}`));
  });

  const request = (method, params, timeoutMs = codexThreadTimeoutMs) => new Promise((resolve, reject) => {
    if (closed || closing) {
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
    if (closed || closing) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The child close handler will reject the active request, if any.
    }
  };

  const close = () => {
    if (closed || closing) return;
    closing = true;
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
    onClose(listener) {
      if (closed) {
        listener(new Error("Codex app-server 已关闭。"));
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close,
  };
}

async function runCodexNewThread({ task, cwd = defaultCwd, model, effort, signal }) {
  const resolvedCwd = path.resolve(cwd);
  const release = beginDelegation("codex_new_thread", task, resolvedCwd);
  let client;
  let cancelWait;
  try {
    throwIfAborted(signal);
    client = await openCodexAppServer();
    let threadId = "";
    let turnId = "";
    let finalText = "";
    let finished = false;
    let unsubscribe;
    let unsubscribeClose;
    let timer;

    const finishedPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe?.();
        unsubscribeClose?.();
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const interruptThenFinish = async (error) => {
        if (finished) return;
        if (threadId && turnId) {
          try {
            await client.request("turn/interrupt", { threadId, turnId }, 5_000);
          } catch (interruptError) {
            log(`Codex turn/interrupt 失败：${safeText(interruptError?.message || interruptError, 1200)}`);
          }
        }
        finish(error);
      };
      const onAbort = () => {
        void interruptThenFinish(abortError(signal.reason?.message || "操作已取消。"));
      };
      cancelWait = () => finish(new Error("Codex 新任务已关闭。"));
      unsubscribe = client.onEvent((message) => {
        const method = String(message?.method || "");
        const params = message?.params || {};
        const turn = params.turn || params;
        const eventThreadId = params.threadId || turn.threadId;
        const eventTurnId = params.turnId || turn.turnId || turn.id;
        if (eventThreadId && threadId && eventThreadId !== threadId) return;
        if (eventTurnId && turnId && eventTurnId !== turnId) return;

        if (method === "turn/started" || method === "turn_started" || method === "turn/created") {
          turnId ||= params.turnId || turn.turnId || turn.id || "";
          return;
        }
        if (method === "item/completed" || method === "item_completed") {
          const text = extractCodexAgentText(params.item || params);
          if (text) finalText = text;
          return;
        }
        if (method === "turn/failed" || method === "turn_failed") {
          finish(new Error(turn.error?.message || params.error?.message || "Codex 新任务执行失败。"));
          return;
        }
        if (method === "turn/interrupted" || method === "turn_interrupted") {
          finish(new Error("Codex 新任务被中断。"));
          return;
        }
        if (method === "turn/completed" || method === "turn_completed") {
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
      unsubscribeClose = client.onClose((error) => finish(error));
      timer = setTimeout(() => {
        void interruptThenFinish(new Error("等待 Codex 新对话首轮响应超时。"));
      }, codexThreadTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });

    await client.request("initialize", {
      clientInfo: {
        name: "hanako-codex-bridge",
        title: "Hanako → Codex thread bridge",
        version: "0.3.0",
      },
      capabilities: {},
    });
    throwIfAborted(signal);
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
    if (!threadId) throw new Error("Codex app-server 没有返回新任务 ID。");
    throwIfAborted(signal);

    const turnParams = {
      threadId,
      input: [{ type: "text", text: task }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
    if (effort) turnParams.effort = effort;
    const turnStarted = await client.request("turn/start", turnParams);
    turnId = turnStarted?.turn?.id || turnStarted?.turnId || turnStarted?.turn?.turnId || "";
    throwIfAborted(signal);
    const result = await finishedPromise;
    return JSON.stringify({
      threadId,
      status: "completed",
      result: result || finalText || "Codex 已完成任务，但没有返回文字结果。",
      cwd: resolvedCwd,
      persistent: true,
    }, null, 2);
  } finally {
    cancelWait?.();
    client?.close();
    release();
  }
}

async function probeHanako(info) {
  return await new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(status);
    };
    try {
      socket = net.createConnection({ host: "127.0.0.1", port: info.port });
      socket.setTimeout(3_000, () => finish("unreachable"));
      socket.once("connect", () => finish("reachable"));
      socket.once("error", () => finish("unreachable"));
      socket.once("close", () => finish("unreachable"));
    } catch {
      finish("unreachable");
    }
  });
}

async function probeCodexExecutable(executable) {
  return await new Promise((resolve) => {
    let child;
    let settled = false;
    const timer = setTimeout(() => finish("unavailable"), 5_000);
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
          // Ignore a process that already exited.
        }
      }
      resolve(status);
    };
    try {
      child = spawn(executable, ["--version"], {
        cwd: defaultCwd,
        env: getCodexEnvironment(),
        windowsHide: true,
        shell: process.platform === "win32" && /\.cmd$/i.test(executable),
        stdio: "ignore",
      });
      child.once("error", () => finish("unavailable"));
      child.once("close", (code) => finish(code === 0 ? "available" : "unavailable"));
    } catch {
      finish("unavailable");
    }
  });
}

async function bridgeStatus() {
  let hanakoServer = "unconfigured";
  let codex = "unavailable";
  const loopGuard = globalLoopGuardIsActive() ? "busy" : "clear";
  try {
    const info = await readHanakoInfo();
    hanakoServer = await probeHanako(info);
  } catch {
    // Do not include the token, port, or raw path in status output.
  }
  try {
    const executable = await resolveCodexExecutable();
    codex = await probeCodexExecutable(executable);
  } catch {
    codex = "unavailable";
  }
  return JSON.stringify({
    bridge: "hanako-codex-bridge",
    mode: "local-two-way-full-access",
    hanakoServer,
    codex,
    loopGuard,
    configuredCwd: Boolean(process.env.BRIDGE_DEFAULT_CWD),
    activeDelegations: activeDelegations.size,
    limits: {
      maxConcurrent: maxActiveDelegations,
      maxHops: maxDelegationHops,
    },
    node: process.version,
  }, null, 2);
}

const toolDefinitions = [
  {
    name: "codex_task",
    description: "仅在用户明确要求一次性委派并只返回结果时使用；不会创建可继续的 Codex 新对话。",
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
    description: "当用户表达了把任务交给、委派给、转交给、让 Codex 或另一个编码助手处理，或要求另开/新建独立任务或对话时使用。通过 Codex app-server 创建持久新对话，把任务作为首轮消息发送，并返回 threadId 和结果。不要要求用户输入工具名。",
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

function rpcError(id, code, message, data) {
  const error = { code, message: safeText(message, 4000) };
  if (data !== undefined) error.data = data;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error })}\n`);
}

function errorResponse(id, message) {
  response(id, {
    content: [{ type: "text", text: safeText(message, 4000) }],
    isError: true,
  });
}

let initializeReceived = false;
let initialized = false;
let negotiatedProtocolVersion = null;

function requestKey(id) {
  return `${typeof id}:${String(id)}`;
}

function requiresInitialized(id) {
  if (initialized) return true;
  rpcError(id, -32002, "MCP server 尚未初始化，请先完成 initialize 和 notifications/initialized。");
  return false;
}

async function handleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string") {
    rpcError(null, -32600, "无效的 JSON-RPC 请求。");
    return;
  }
  const id = request.id;
  if (request.method === "initialize") {
    if (initializeReceived) {
      rpcError(id, -32600, "MCP server 已经初始化，不能重复 initialize。");
      return;
    }
    const requestedProtocolVersion = request.params?.protocolVersion;
    if (requestedProtocolVersion && !supportedProtocolVersions.has(requestedProtocolVersion)) {
      rpcError(id, -32602, "不支持的 MCP protocolVersion。", {
        supported: [...supportedProtocolVersions],
      });
      return;
    }
    initializeReceived = true;
    negotiatedProtocolVersion = requestedProtocolVersion || bridgeProtocolVersion;
    response(id, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hanako-codex-bridge", version: "0.3.0" },
      instructions: "当用户用自然语言表达把任务交给、委派给、转交给、让 Codex 或另一个编码助手处理，或要求另开/新建独立任务或对话时，调用 codex_new_thread 创建持久 Codex 对话；不要要求用户输入工具名。只有用户明确要求一次性返回结果、不要创建新对话时才调用 codex_task。继续已有 Codex 对话需保留原 threadId。委派任务使用完全访问模式。桥接器会过滤 Hanako 会话事件、支持取消，并阻止下游 Codex 重新进入桥接器形成循环。",
    });
    return;
  }
  if (request.method === "notifications/initialized") {
    if (initializeReceived) initialized = true;
    return;
  }
  if (request.method === "notifications/cancelled") {
    const cancelledId = request.params?.requestId;
    if (cancelledId !== undefined && cancelledId !== null) {
      const entry = activeRequests.get(requestKey(cancelledId));
      entry?.controller.abort(abortError(request.params?.reason || "调用方取消了该 MCP 请求。"));
    }
    return;
  }
  if (request.method === "ping") {
    if (id !== undefined) response(id, {});
    return;
  }
  if (request.method === "tools/list") {
    if (!requiresInitialized(id)) return;
    response(id, { tools: toolDefinitions });
    return;
  }
  if (request.method !== "tools/call") {
    rpcError(id, -32601, `不支持的 MCP 方法：${request.method}`);
    return;
  }
  if (!requiresInitialized(id)) {
    return;
  }
  if (id === undefined) {
    rpcError(null, -32600, "tools/call 必须使用带 id 的 JSON-RPC 请求。");
    return;
  }

  const name = request.params?.name;
  const args = request.params?.arguments || {};
  const controller = new AbortController();
  const key = requestKey(id);
  if (activeRequests.has(key)) {
    rpcError(id, -32600, "不能复用仍在执行中的 JSON-RPC id。");
    return;
  }
  if (key) activeRequests.set(key, { controller, name });
  try {
    let result;
    if (name === "bridge_status") {
      result = await bridgeStatus();
      throwIfAborted(controller.signal);
    }
    else if (name === "codex_task") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("codex_task 需要非空 task。");
      result = await runCodexTask({ task: args.task, cwd: args.cwd, signal: controller.signal });
    } else if (name === "codex_new_thread") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("codex_new_thread 需要非空 task。");
      result = await runCodexNewThread({
        task: args.task,
        cwd: args.cwd,
        model: args.model,
        effort: args.effort,
        signal: controller.signal,
      });
    } else if (name === "hanako_task") {
      if (typeof args.task !== "string" || !args.task.trim()) throw new Error("hanako_task 需要非空 task。");
      result = await runHanakoTask({ task: args.task, agentId: args.agentId || "hanako", signal: controller.signal });
    } else {
      throw new Error(`未知工具：${name}`);
    }
    if (controller.signal.aborted) return;
    response(id, { content: [{ type: "text", text: String(result) }], isError: false });
  } catch (error) {
    if (controller.signal.aborted) return;
    errorResponse(id, error?.message || error);
  } finally {
    if (key) activeRequests.delete(key);
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      rpcError(null, -32700, "无法解析的 JSON。");
      return;
    }
    void handleRequest(request).catch((error) => {
      if (request?.method === "tools/call" && request.id !== undefined && activeRequests.has(requestKey(request.id))) {
        errorResponse(request.id, error?.message || error);
      } else {
        rpcError(request?.id, -32603, error?.message || error);
      }
    });
  });

  input.on("close", () => {
    for (const entry of activeRequests.values()) {
      entry.controller.abort(abortError("MCP 输入流已关闭。"));
    }
    process.exitCode = 0;
  });
}

export { belongsToHanakoSession, consumeJsonLines };
