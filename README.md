# Hanako ↔ Codex Local Bridge

一个本地 MCP stdio 桥接器，让 Hanako 与 Codex 可以互相委派文字任务，并把最终结果返回给调用方。

## 功能

- Hanako 调用 codex_task：启动一次性的本机 Codex 子任务。
- Hanako 调用 codex_new_thread：通过 Codex app-server 创建一个持久的新 Codex 对话，并发送首轮任务。
- Codex 调用 hanako_task：创建一次本机 Hanako detached session。
- 任一侧调用 bridge_status：检查 Hanako 服务和 Codex 可执行文件是否可发现。
- 不复制完整对话历史；每次委派只发送调用方提供的任务文字。

## 重要安全说明

本仓库当前配置的是完全访问模式：

- Hanako detached session 使用 operate 权限。
- Codex 子任务使用 --dangerously-bypass-approvals-and-sandbox。
- 委派任务可以读写本机文件、执行命令、安装软件并访问网络。
- codex_new_thread 创建的 Codex 对话使用持久 thread；调用完成后可以在 Codex 桌面端的任务列表中继续查看。
- 桥接器会读取 Hanako 本地服务令牌，但只保存在内存中，不写入日志、不返回给模型。

只把它接入你信任的 Hanako/Codex 实例，并只委派可信任务。不要把本服务暴露到局域网或公网，也不要把 server-info.json、访问令牌或个人配置提交到仓库。

## 系统要求

- Windows、macOS 或 Linux
- Node.js 22 或更新版本
- 已安装并可运行的 Codex CLI
- Codex CLI 需要支持实验性的 app-server（codex_new_thread 使用该接口创建持久对话）
- 正在运行的 Hanako，并且本机可读取 Hanako 的 server-info.json

Node.js 22+ 是为了使用内置 WebSocket；桥接器本身不需要 npm 依赖。

## 安装

把 bridge.mjs 下载到本机固定目录，例如：

~~~text
C:\Tools\hanako-codex-bridge\bridge.mjs
~~~

不要把个人 Codex 配置、Hanako server-info.json 或访问令牌复制进这个目录。

## 配置 Codex

在 Codex 的 config.toml 中添加一个 MCP server。把下面的路径改成 bridge.mjs 的实际路径：

~~~toml
[mcp_servers.hanako-codex-bridge]
command = "node"
args = ["C:\\Tools\\hanako-codex-bridge\\bridge.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 900.0
~~~

macOS/Linux 示例：

~~~toml
[mcp_servers.hanako-codex-bridge]
command = "node"
args = ["/opt/hanako-codex-bridge/bridge.mjs"]
default_tools_approval_mode = "approve"
tool_timeout_sec = 900.0
~~~

完全访问模式下，approve 是有意为桥接工具打开自动执行。它只应配置在这个受信任的本地桥接 server 上，不要为了方便把所有 MCP server 都设成同样的策略。

修改后重启 Codex，或在客户端中重新加载 MCP servers。

## 配置 Hanako

在 Hanako 的 MCP connector 设置中添加一个 stdio server，使用与 Codex 相同的 bridge.mjs：

~~~text
Transport: stdio
Command: node
Arguments: C:\Tools\hanako-codex-bridge\bridge.mjs
Enabled agents: 需要使用桥接的 Hanako agent，例如 hanako、hakimi
~~~

不同版本的 Hanako 可能使用不同的字段名称；核心配置只有三项：stdio、node、bridge.mjs 的绝对路径。

Hanako 必须处于运行状态，并且本机存在由 Hanako 生成的 server-info.json。默认位置是：

~~~text
Windows: %USERPROFILE%\.hanako\server-info.json
macOS/Linux: ~/.hanako/server-info.json
~~~

## 可选环境变量

~~~text
HANAKO_SERVER_INFO       自定义 Hanako server-info.json 路径
CODEX_EXECUTABLE         自定义 Codex 可执行文件路径
BRIDGE_DEFAULT_CWD       Codex 子任务默认工作目录
CODEX_BRIDGE_TIMEOUT_MS  Codex 子任务超时，默认 1200000
CODEX_THREAD_TIMEOUT_MS  持久 Codex 新对话首轮超时，默认跟随 CODEX_BRIDGE_TIMEOUT_MS
HANAKO_BRIDGE_TIMEOUT_MS Hanako 子任务超时，默认 900000
~~~

例如在 PowerShell 中：

~~~powershell
$env:BRIDGE_DEFAULT_CWD = "C:\Work\my-project"
node C:\Tools\hanako-codex-bridge\bridge.mjs
~~~

## 三个 MCP 工具

### 自然语言触发

正常使用时不需要输入工具名。在 Hanako 中，只要表达出类似下面的意图即可：

- 把这个任务交给 Codex
- 让 Codex 处理、检查、修复或开发
- 把工作转交给另一个编码助手
- 另开一个独立任务或 Codex 对话

例如：

~~~text
把这个项目的测试问题转交给 Codex，在 C:\\Work\\my-project 中修复，完成后把结果告诉我。
~~~

Hanako 会优先调用 `codex_new_thread` 创建持久 Codex 对话。只有明确说“只要一次性结果、不要创建新对话”时，才使用 `codex_task`。

### bridge_status

查看桥接器、Hanako 本地服务和 Codex 可执行文件状态。不会返回 Hanako 令牌。

### codex_task

从 Hanako 或其他 MCP 客户端委派给 Codex：

~~~json
{
  "task": "检查项目当前测试状态，并返回简短结论",
  "cwd": "C:\\Work\\my-project"
}
~~~

### hanako_task

从 Codex 委派给 Hanako：

~~~json
{
  "agentId": "hakimi",
  "task": "阅读当前任务背景，给出一份简短的风险检查清单"
}
~~~

任务文本会被转交给另一侧；不要在任务文本中放入密码、令牌或其他不必要的敏感信息。

### codex_new_thread

从 Hanako 创建一个真正持久的 Codex 新任务：

~~~json
{
  "task": "检查当前项目的测试状态，并把结论写成简短报告",
  "cwd": "C:\\Work\\my-project"
}
~~~

返回结果类似：

~~~json
{
  "threadId": "...",
  "status": "completed",
  "result": "...",
  "persistent": true
}
~~~

这里的 `threadId` 是 Codex 的持久任务 ID；它和 `codex_task` 的一次性子进程不同。

## 验证

安装完成后按这个顺序验证：

1. 调用 bridge_status，确认 Hanako server 与 Codex executable 都是 available。
2. 从 Codex 调用 hanako_task，让 Hanako 只回复一个固定短语。
3. 从 Hanako 调用 codex_task，让 Codex 只回复另一个固定短语。
4. 确认两边都能收到结果后，再委派真实任务。

测试时先使用“不修改文件、不安装软件、不访问外部服务”的短任务。

## 故障排查

### Hanako 本地服务不可用

确认 Hanako 正在运行，并检查 server-info.json 是否存在、JSON 是否完整。可用 HANAKO_SERVER_INFO 指向自定义位置。

### 找不到 Codex

确认 Codex CLI 已安装并在 PATH 中。也可以使用 CODEX_EXECUTABLE 指向 codex.exe 或 codex 的绝对路径。

### MCP 工具调用需要审批

确认只有 hanako-codex-bridge 的 default_tools_approval_mode 设置为 approve，并重启 Codex 让 config.toml 生效。不要把这个设置扩展到不受信任的 MCP server。

### 任务超时

首次启动 Codex/Hanako 可能需要较长时间。提高 CODEX_BRIDGE_TIMEOUT_MS 或 HANAKO_BRIDGE_TIMEOUT_MS，并确认 Codex 的 tool_timeout_sec 足够大。

## 开发

本项目没有第三方 npm 依赖。可以使用下面的命令做语法检查：

~~~powershell
node --check bridge.mjs
~~~

桥接器使用 JSON-RPC over stdio 与 MCP 客户端通信；Hanako 一侧使用本机 HTTP API 和 WebSocket，Codex 一侧同时支持一次性的 `codex exec` 子进程和通过 `codex app-server` 创建持久 thread。

## 许可

当前仓库未附加开源许可证。除非仓库所有者另行添加许可证，否则默认保留所有权利。
