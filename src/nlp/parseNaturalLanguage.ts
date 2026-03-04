export interface ParsedNlCommand {
  slashCommand: string;
  args: Record<string, string | boolean>;
  preview: string;
}

export interface FreeTextParseOptions {
  defaultRepoId?: string | null;
  allowImplicitTaskIntent?: boolean;
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizeTrigger(content: string, prefix: string, botId: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }

  const mentionPrefix = `<@${botId}>`;
  const mentionNickPrefix = `<@!${botId}>`;

  if (trimmed.startsWith(mentionPrefix)) {
    return trimmed.slice(mentionPrefix.length).trim();
  }
  if (trimmed.startsWith(mentionNickPrefix)) {
    return trimmed.slice(mentionNickPrefix.length).trim();
  }

  return null;
}

function normalizeBody(body: string): string {
  return body
    .replace(/[：]/g, ":")
    .replace(/[＝]/g, "=")
    .replace(/[，]/g, ",")
    .trim();
}

const commandAliasMap: Record<string, string> = {
  ping: "ping",
  健康检查: "ping",
  连通性: "ping",

  repos: "repos",
  repo: "repos",
  仓库: "repos",
  仓库列表: "repos",

  status: "status",
  状态: "status",
  进度: "status",

  approve: "approve",
  批准: "approve",
  同意: "approve",

  reject: "reject",
  拒绝: "reject",

  cancel: "cancel",
  取消: "cancel",

  run: "run",
  执行: "run",
  运行: "run",

  open: "open",
  打开: "open",
  打开vscode: "open",

  read: "read",
  cat: "read",
  查看文件: "read",
  读取: "read",
  读文件: "read",
  读一下: "read",

  task: "task",
  任务: "task",
  新建任务: "task",
  创建任务: "task"
};

const keyAliasMap: Record<string, string> = {
  repo: "repo",
  仓库: "repo",
  项目: "repo",

  prompt: "prompt",
  需求: "prompt",
  内容: "prompt",
  描述: "prompt",
  指令: "prompt",

  task_id: "task_id",
  task: "task_id",
  任务: "task_id",
  任务id: "task_id",

  reason: "reason",
  原因: "reason",

  cmd: "cmd",
  命令: "cmd",

  path: "path",
  file: "path",
  文件: "path",
  文件路径: "path",

  start_line: "start_line",
  起始行: "start_line",
  开始行: "start_line",

  end_line: "end_line",
  结束行: "end_line",
  截止行: "end_line",

  max_chars: "max_chars",
  最大字符: "max_chars",
  字符上限: "max_chars",

  base_branch: "base_branch",
  基线分支: "base_branch",
  分支: "base_branch",

  test_profile: "test_profile",
  测试配置: "test_profile",
  测试: "test_profile",
  profile: "test_profile",

  open_vscode: "open_vscode",
  open: "open_vscode",
  打开vscode: "open_vscode"
};

function normalizeCommand(input: string): string | null {
  const key = input.replace(/^\//, "").toLowerCase();
  return commandAliasMap[key] ?? commandAliasMap[input] ?? null;
}

function normalizeKey(input: string): string {
  const lower = input.toLowerCase();
  return keyAliasMap[lower] ?? keyAliasMap[input] ?? lower;
}

function parseFromRest(rest: string): { keyValues: Record<string, string>; plain: string[] } {
  const keyValues: Record<string, string> = {};
  let residue = rest;
  const regex = /([\p{L}\p{N}_-]+)\s*[=:]\s*("[^"]*"|'[^']*'|[^,\s]+)/gu;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(rest)) !== null) {
    const key = normalizeKey(match[1]);
    const raw = match[2];
    const value =
      (raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
    keyValues[key] = value;
    residue = residue.replace(match[0], " ");
  }

  const plain = tokenize(residue);
  return { keyValues, plain };
}

function findMarkerValue(plain: string[], markers: string[]): string | null {
  for (let i = 0; i < plain.length - 1; i += 1) {
    const token = plain[i].toLowerCase();
    if (markers.includes(token) || markers.includes(plain[i])) {
      return plain[i + 1];
    }
  }
  return null;
}

function findPromptFromMarkers(plain: string[], markers: string[]): string | null {
  for (let i = 0; i < plain.length; i += 1) {
    const token = plain[i].toLowerCase();
    if (markers.includes(token) || markers.includes(plain[i])) {
      const rest = plain.slice(i + 1).join(" ").trim();
      return rest.length > 0 ? rest : null;
    }
  }
  return null;
}

export function parseNaturalLanguageBody(rawBody: string): ParsedNlCommand | null {
  const body = normalizeBody(rawBody);
  const tokens = tokenize(body);
  if (tokens.length === 0) {
    return null;
  }

  const command = normalizeCommand(tokens[0]);
  if (!command) {
    return null;
  }

  const rest = body.slice(tokens[0].length).trim();
  const { keyValues, plain } = parseFromRest(rest);

  if (command === "repos") {
    return {
      slashCommand: "repos",
      args: {},
      preview: "/repos"
    };
  }

  if (command === "ping") {
    return {
      slashCommand: "ping",
      args: {},
      preview: "/ping"
    };
  }

  if (command === "status" || command === "approve" || command === "cancel" || command === "open") {
    const taskId = keyValues.task_id ?? findMarkerValue(plain, ["task", "任务", "任务id"]) ?? plain[0];
    if (!taskId) {
      return null;
    }
    return {
      slashCommand: command,
      args: { task_id: taskId },
      preview: `/${command} task_id=${taskId}`
    };
  }

  if (command === "reject") {
    const taskId = keyValues.task_id ?? findMarkerValue(plain, ["task", "任务", "任务id"]) ?? plain[0];
    if (!taskId) {
      return null;
    }
    const reason = keyValues.reason ?? findPromptFromMarkers(plain, ["reason", "原因"]) ?? plain.slice(1).join(" ");
    return {
      slashCommand: "reject",
      args: reason ? { task_id: taskId, reason } : { task_id: taskId },
      preview: reason ? `/reject task_id=${taskId} reason=${reason}` : `/reject task_id=${taskId}`
    };
  }

  if (command === "run") {
    const taskId = keyValues.task_id ?? findMarkerValue(plain, ["task", "任务", "任务id"]) ?? plain[0];
    const cmd =
      keyValues.cmd ??
      findPromptFromMarkers(plain, ["cmd", "命令"]) ??
      plain.slice(taskId === plain[0] ? 1 : 0).join(" ");

    if (!taskId || !cmd) {
      return null;
    }

    return {
      slashCommand: "run",
      args: { task_id: taskId, cmd },
      preview: `/run task_id=${taskId} cmd=${cmd}`
    };
  }

  if (command === "read") {
    const filePath =
      keyValues.path ??
      findPromptFromMarkers(plain, ["path", "文件", "文件路径", "file"]) ??
      plain.find((token) => /^[a-zA-Z]:[\\/]/.test(token) || token.startsWith("/")) ??
      null;
    if (!filePath) {
      return null;
    }

    const args: Record<string, string | boolean> = { path: filePath };
    const repo = keyValues.repo ?? findMarkerValue(plain, ["repo", "仓库", "项目"]);
    if (repo) {
      args.repo = repo;
    }
    if (keyValues.start_line) {
      args.start_line = keyValues.start_line;
    }
    if (keyValues.end_line) {
      args.end_line = keyValues.end_line;
    }
    if (keyValues.max_chars) {
      args.max_chars = keyValues.max_chars;
    }

    return {
      slashCommand: "read",
      args,
      preview: `/read path=${filePath}${repo ? ` repo=${repo}` : ""}`
    };
  }

  if (command === "task") {
    const repo =
      keyValues.repo ??
      findMarkerValue(plain, ["repo", "仓库", "项目"]) ??
      (plain[0] && !["repo", "仓库", "项目"].includes(plain[0].toLowerCase()) ? plain[0] : null);

    const promptFromMarked = findPromptFromMarkers(plain, ["prompt", "需求", "内容", "描述", "指令"]);
    const promptFromPlain = plain.slice(repo === plain[0] ? 1 : 0).join(" ").trim();
    const prompt = keyValues.prompt ?? promptFromMarked ?? promptFromPlain;

    if (!repo || !prompt) {
      return null;
    }

    const args: Record<string, string | boolean> = {
      repo,
      prompt
    };

    const baseBranch = keyValues.base_branch;
    if (baseBranch) {
      args.base_branch = baseBranch;
    }

    const testProfile = keyValues.test_profile;
    if (testProfile) {
      args.test_profile = testProfile;
    }

    const openVsCode = keyValues.open_vscode;
    if (openVsCode) {
      const raw = openVsCode.toLowerCase();
      args.open_vscode = raw === "true" || raw === "1" || raw === "yes" || raw === "是";
    }

    return {
      slashCommand: "task",
      args,
      preview: `/task repo=${repo} prompt=${prompt}`
    };
  }

  return null;
}

function extractTaskId(text: string): string | null {
  const taskPattern = /\b(task-[a-z0-9-]{6,})\b/i;
  const m1 = text.match(taskPattern);
  if (m1) {
    return m1[1];
  }

  const m2 = text.match(/(?:任务|task)(?:id)?\s*[:=：]?\s*([a-z0-9-]{6,})/i);
  if (m2) {
    return m2[1];
  }
  return null;
}

function extractRepoId(text: string): string | null {
  const m = text.match(/(?:repo|仓库|项目)\s*[:=：]\s*([a-z0-9._-]+)/i);
  return m ? m[1] : null;
}

function extractAfterMarkers(text: string, markers: string[]): string | null {
  for (const marker of markers) {
    const idx = text.toLowerCase().indexOf(marker.toLowerCase());
    if (idx >= 0) {
      const rest = text.slice(idx + marker.length).replace(/^[\s:=：,，]+/, "").trim();
      if (rest) {
        return rest;
      }
    }
  }
  return null;
}

function extractFilePath(text: string): string | null {
  const quoted = text.match(/["'`](?<path>(?:[a-zA-Z]:\\|\/)[^"'`]+)["'`]/);
  const fromQuoted = quoted?.groups?.path?.trim();
  if (fromQuoted) {
    return fromQuoted;
  }

  const win = text.match(/[a-zA-Z]:\\[^\s"'`，。,；;）)]+/);
  if (win?.[0]) {
    return win[0].trim();
  }

  const unix = text.match(/\/[^\s"'`，。,；;）)]+/);
  if (unix?.[0]) {
    return unix[0].trim();
  }

  return null;
}

export function parseNaturalLanguageFreeText(
  rawText: string,
  options: FreeTextParseOptions = {}
): ParsedNlCommand | null {
  const text = normalizeBody(rawText);
  if (!text) {
    return null;
  }

  const direct = parseNaturalLanguageBody(text);
  if (direct) {
    return direct;
  }

  if (/(在线吗|在吗|健康检查|连通性|ping)/i.test(text)) {
    return {
      slashCommand: "ping",
      args: {},
      preview: "/ping"
    };
  }

  if (/(仓库|repo)/i.test(text) && /(列表|查看|有哪些|show|list|看看)/i.test(text)) {
    return {
      slashCommand: "repos",
      args: {},
      preview: "/repos"
    };
  }

  const taskId = extractTaskId(text);
  if (taskId && /(状态|进度|status)/i.test(text)) {
    return {
      slashCommand: "status",
      args: { task_id: taskId },
      preview: `/status task_id=${taskId}`
    };
  }

  if (taskId && /(批准|同意|approve)/i.test(text)) {
    return {
      slashCommand: "approve",
      args: { task_id: taskId },
      preview: `/approve task_id=${taskId}`
    };
  }

  if (taskId && /(拒绝|reject)/i.test(text)) {
    const reason = extractAfterMarkers(text, ["原因", "reason"]);
    return {
      slashCommand: "reject",
      args: reason ? { task_id: taskId, reason } : { task_id: taskId },
      preview: reason
        ? `/reject task_id=${taskId} reason=${reason}`
        : `/reject task_id=${taskId}`
    };
  }

  if (taskId && /(取消|cancel)/i.test(text)) {
    return {
      slashCommand: "cancel",
      args: { task_id: taskId },
      preview: `/cancel task_id=${taskId}`
    };
  }

  if (taskId && /(打开|open)/i.test(text)) {
    return {
      slashCommand: "open",
      args: { task_id: taskId },
      preview: `/open task_id=${taskId}`
    };
  }

  if (taskId && /(执行|运行|run)/i.test(text)) {
    const cmd = extractAfterMarkers(text, ["命令", "cmd", "执行", "运行"]);
    if (cmd) {
      return {
        slashCommand: "run",
        args: { task_id: taskId, cmd },
        preview: `/run task_id=${taskId} cmd=${cmd}`
      };
    }
  }

  if (/(读取|读一下|读出|查看文件|读文件|read file|read|cat)/i.test(text)) {
    const filePath = extractFilePath(text);
    if (filePath) {
      return {
        slashCommand: "read",
        args: { path: filePath },
        preview: `/read path=${filePath}`
      };
    }
  }

  const conversationOnlyPattern = /(讲个?故事|故事|笑话|段子|闲聊|聊聊|写首诗|诗歌|唱歌)/i;
  const technicalIntentPattern =
    /(修复|修改|优化|重构|实现|编写|代码|脚本|接口|测试|部署|配置|依赖|登录|功能|文件|目录|路径|repo|仓库|项目|create|fix|implement|refactor|build|test|code)/i;
  if (conversationOnlyPattern.test(text) && !technicalIntentPattern.test(text)) {
    return null;
  }

  const taskIntentPattern =
    /(创建|新建|修复|修改|优化|重构|实现|编写|写个|写一个|做个|做一个|帮我|create|fix|implement|refactor|build|add)/i;
  const allowImplicitTaskIntent = options.allowImplicitTaskIntent ?? true;
  if (!allowImplicitTaskIntent) {
    return null;
  }

  if (taskIntentPattern.test(text)) {
    const repo = extractRepoId(text) ?? options.defaultRepoId ?? null;
    if (!repo) {
      return null;
    }
    return {
      slashCommand: "task",
      args: { repo, prompt: text },
      preview: `/task repo=${repo} prompt=${text}`
    };
  }

  return null;
}

export function parseNaturalLanguageCommand(
  content: string,
  prefix: string,
  botId: string
): ParsedNlCommand | null {
  const body = normalizeTrigger(content, prefix, botId);
  if (!body) {
    return null;
  }

  return parseNaturalLanguageBody(body);
}
