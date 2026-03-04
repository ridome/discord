import { z } from "zod";
import { ParsedNlCommand } from "../nlp/parseNaturalLanguage";
import { Logger } from "../logger";
import { requestJson } from "../utils/http";

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface GeminiAssistantOptions {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
  timeoutMs: number;
  strictModel: boolean;
  proxyUrl?: string | null;
}

export interface GeminiAssistResult {
  command: ParsedNlCommand | null;
  reply: string | null;
  memoryToSave: string | null;
}

export type GeminiInterpretMode = "auto" | "reply_only";

const evolutionSchema = z.object({
  memories: z.array(z.string()).default([])
});

const decisionSchema = z.object({
  mode: z.enum(["command", "reply", "none"]),
  slashCommand: z.string().optional(),
  args: z.record(z.union([z.string(), z.boolean()])).optional(),
  reply: z.string().optional(),
  memory: z
    .object({
      remember: z.boolean().optional(),
      content: z.string().optional()
    })
    .optional()
});

const allowedCommands = new Set([
  "ping",
  "repos",
  "status",
  "approve",
  "reject",
  "cancel",
  "run",
  "open",
  "read",
  "task",
  "provider"
]);

const defaultFallbackModels = ["gemini-2.0-flash", "gemini-1.5-flash"];

function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    throw new Error("Empty Gemini output");
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }
  return JSON.parse(text);
}

function tryExtractLooseJson(raw: string): unknown {
  try {
    return extractJson(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error("No valid JSON object in Gemini output");
  }
}

function toBoolean(input: string | boolean | undefined): boolean | undefined {
  if (typeof input === "boolean") {
    return input;
  }
  if (typeof input !== "string") {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  if (["true", "1", "yes", "y", "是", "开", "on"].includes(value)) {
    return true;
  }
  if (["false", "0", "no", "n", "否", "关", "off"].includes(value)) {
    return false;
  }
  return undefined;
}

function buildPreview(command: string, args: Record<string, string | boolean>): string {
  if (command === "ping" || command === "repos") {
    return `/${command}`;
  }
  if (command === "status" || command === "approve" || command === "cancel" || command === "open") {
    return `/${command} task_id=${String(args.task_id ?? "")}`.trim();
  }
  if (command === "reject") {
    if (args.reason) {
      return `/reject task_id=${String(args.task_id ?? "")} reason=${String(args.reason)}`;
    }
    return `/reject task_id=${String(args.task_id ?? "")}`;
  }
  if (command === "run") {
    return `/run task_id=${String(args.task_id ?? "")} cmd=${String(args.cmd ?? "")}`.trim();
  }
  if (command === "read") {
    const base = `/read path=${String(args.path ?? "")}`.trim();
    const repo = String(args.repo ?? "").trim();
    if (repo) {
      return `${base} repo=${repo}`.trim();
    }
    return base;
  }
  if (command === "task") {
    return `/task repo=${String(args.repo ?? "")} prompt=${String(args.prompt ?? "")}`.trim();
  }
  if (command === "provider") {
    const mode = String(args.mode ?? "").trim();
    return mode ? `/provider mode=${mode}` : "/provider";
  }
  return `/${command}`;
}

export function normalizeGeminiDecision(
  raw: unknown
): GeminiAssistResult {
  const parsed = decisionSchema.parse(raw);
  const rawMemory = parsed.memory;
  const memoryText =
    rawMemory?.remember && rawMemory.content
      ? rawMemory.content.trim().replace(/\s+/g, " ").slice(0, 240)
      : "";
  const memoryToSave = memoryText.length > 0 ? memoryText : null;

  if (parsed.mode === "reply") {
    return {
      command: null,
      reply: parsed.reply?.trim() ? parsed.reply.trim() : "我还不能执行这个请求，请改成任务命令。",
      memoryToSave
    };
  }

  if (parsed.mode === "none") {
    return { command: null, reply: null, memoryToSave };
  }

  const command = String(parsed.slashCommand ?? "").trim().replace(/^\//, "");
  if (!allowedCommands.has(command)) {
    return { command: null, reply: null, memoryToSave };
  }

  const args: Record<string, string | boolean> = {};
  const inputArgs = parsed.args ?? {};

  if (command === "ping" || command === "repos") {
    return {
      command: {
        slashCommand: command,
        args: {},
        preview: buildPreview(command, {})
      },
      reply: null,
      memoryToSave
    };
  }

  if (command === "status" || command === "approve" || command === "cancel" || command === "open") {
    const taskId = String(inputArgs.task_id ?? "").trim();
    if (!taskId) {
      return { command: null, reply: null, memoryToSave };
    }
    args.task_id = taskId;
    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  if (command === "reject") {
    const taskId = String(inputArgs.task_id ?? "").trim();
    if (!taskId) {
      return { command: null, reply: null, memoryToSave };
    }
    args.task_id = taskId;
    const reason = String(inputArgs.reason ?? "").trim();
    if (reason) {
      args.reason = reason;
    }
    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  if (command === "run") {
    const taskId = String(inputArgs.task_id ?? "").trim();
    const cmd = String(inputArgs.cmd ?? "").trim();
    if (!taskId || !cmd) {
      return { command: null, reply: null, memoryToSave };
    }
    args.task_id = taskId;
    args.cmd = cmd;
    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  if (command === "read") {
    const filePath = String(inputArgs.path ?? "").trim();
    if (!filePath) {
      return { command: null, reply: null, memoryToSave };
    }
    args.path = filePath;

    const repo = String(inputArgs.repo ?? "").trim();
    if (repo) {
      args.repo = repo;
    }

    const startLine = String(inputArgs.start_line ?? "").trim();
    if (startLine) {
      args.start_line = startLine;
    }

    const endLine = String(inputArgs.end_line ?? "").trim();
    if (endLine) {
      args.end_line = endLine;
    }

    const maxChars = String(inputArgs.max_chars ?? "").trim();
    if (maxChars) {
      args.max_chars = maxChars;
    }

    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  if (command === "task") {
    const repo = String(inputArgs.repo ?? "").trim();
    const prompt = String(inputArgs.prompt ?? "").trim();
    if (!repo || !prompt) {
      return { command: null, reply: null, memoryToSave };
    }
    args.repo = repo;
    args.prompt = prompt;

    const baseBranch = String(inputArgs.base_branch ?? "").trim();
    if (baseBranch) {
      args.base_branch = baseBranch;
    }

    const testProfile = String(inputArgs.test_profile ?? "").trim();
    if (testProfile) {
      args.test_profile = testProfile;
    }

    const openVsCode = toBoolean(inputArgs.open_vscode as string | boolean | undefined);
    if (typeof openVsCode === "boolean") {
      args.open_vscode = openVsCode;
    }

    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  if (command === "provider") {
    const mode = String(inputArgs.mode ?? "").trim().toLowerCase();
    if (!mode) {
      return {
        command: { slashCommand: command, args: {}, preview: buildPreview(command, {}) },
        reply: null,
        memoryToSave
      };
    }
    if (!["auto", "codex", "gemini"].includes(mode)) {
      return { command: null, reply: null, memoryToSave };
    }
    args.mode = mode;
    return {
      command: { slashCommand: command, args, preview: buildPreview(command, args) },
      reply: null,
      memoryToSave
    };
  }

  return { command: null, reply: null, memoryToSave };
}

function extractCandidateText(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
  return text;
}

function buildPrompt(
  text: string,
  defaultRepoId: string | null,
  allowedRepoIds: string[],
  allowLocalPathRepo: boolean,
  memoryContext: string[],
  recentConversation: string[],
  mode: GeminiInterpretMode
): string {
  const repoHint = defaultRepoId ? `default_repo=${defaultRepoId}` : "default_repo=";
  const allowedRepoHint = `allowed_repo_ids=${allowedRepoIds.join(",")}`;
  const localPathHint = `allow_local_path_repo=${allowLocalPathRepo ? "true" : "false"}`;
  const decisionModeHint = `decision_mode=${mode}`;

  const memoryHint = memoryContext.length
    ? `known_user_memory=${memoryContext.map((m, idx) => `${idx + 1}. ${m}`).join(" | ")}`
    : "known_user_memory=";
  const recentDialogueHint = recentConversation.length
    ? `recent_dialogue=${recentConversation.map((m, idx) => `${idx + 1}. ${m}`).join(" | ")}`
    : "recent_dialogue=";
  const modeRule =
    mode === "reply_only"
      ? "- decision_mode=reply_only: never output mode=command. Only output mode=reply or mode=none."
      : "- decision_mode=auto: choose command/reply/none per user intent.";

  return [
    "You are a bilingual (Chinese-first) assistant for a Discord coding bot.",
    "You support two modes:",
    "1) mode=command: convert user intent into one supported slash command.",
    "2) mode=reply: directly chat/help in natural Chinese.",
    "Output strict JSON only. No markdown.",
    "JSON schema:",
    '{"mode":"command|reply|none","slashCommand":"ping|repos|status|approve|reject|cancel|run|open|read|task|provider","args":{"repo":"...","prompt":"...","task_id":"...","cmd":"...","reason":"...","path":"...","start_line":"...","end_line":"...","max_chars":"...","base_branch":"...","test_profile":"...","open_vscode":true|false,"mode":"auto|codex|gemini"},"reply":"...","memory":{"remember":true|false,"content":"..."}}',
    "Rules:",
    "- Use mode=command only when user clearly wants bot/repo/task actions.",
    "- Use mode=reply for greeting, jokes, stories, explanations, brainstorming, or ambiguous requests.",
    "- For casual chat, be friendly and actually answer the request. Do not refuse with 'I am only DevOps bot'.",
    "- repo for /task must be either one of allowed_repo_ids, or a local absolute path only when allow_local_path_repo=true.",
    "- If allow_local_path_repo=false, never output local absolute path as repo arg.",
    "- If user asks for external path while allow_local_path_repo=false, answer mode=reply and tell them to add id/path mapping in config/repos.json first.",
    "- If user asks whether path/folder can be specified, use mode=reply and include one concrete task command example.",
    "- For local file reading requests, use /read with path; include repo only when user clearly provides it.",
    "- For model/provider switching query, use /provider. Set args.mode only for auto/codex/gemini.",
    "- For task command, include repo and prompt. If repo missing and default_repo exists, use default_repo.",
    "- Never invent task_id if user did not provide one for status/approve/reject/cancel/open/run.",
    "- Keep reply concise and useful (prefer <= 220 Chinese chars).",
    "- If request could be either chat or command and key params are missing, prefer mode=reply with a clarifying question.",
    "- Use recent_dialogue (U: user, A: assistant) to resolve references like '这个/刚刚那个/上一个'.",
    "- For short follow-up messages, continue the same topic from recent_dialogue unless user clearly switches topic.",
    "- If still unclear, ask one short clarifying question.",
    "- Memory rule: if user gives stable preference/fact that helps future collaboration, set memory.remember=true and provide short memory.content in Chinese.",
    "- Do not store secrets/tokens/passwords in memory. For sensitive data, set memory.remember=false.",
    "- If no useful long-term info, set memory.remember=false.",
    modeRule,
    "Examples:",
    '- user_text=你好，给我讲个故事 -> {"mode":"reply","reply":"当然可以...（直接讲一个短故事）"}',
    '- user_text=帮我看 task-abc123 状态 -> {"mode":"command","slashCommand":"status","args":{"task_id":"task-abc123"}}',
    '- user_text=在 sample 仓库修复登录 bug -> {"mode":"command","slashCommand":"task","args":{"repo":"sample","prompt":"修复登录 bug"}}',
    '- user_text=读取 D:\\work\\sample-repo\\a.md -> {"mode":"command","slashCommand":"read","args":{"path":"D:\\\\work\\\\sample-repo\\\\a.md"}}',
    '- user_text=我要仓库外 D:\\work\\test -> if allow_local_path_repo=true then command(/task with repo as that path); otherwise reply with config guidance.',
    allowedRepoHint,
    localPathHint,
    decisionModeHint,
    `${repoHint}`,
    memoryHint,
    recentDialogueHint,
    `user_text=${text}`
  ].join("\n");
}

function sanitizeReplyText(raw: string): string {
  const trimmed = raw.trim();
  const noFence = trimmed.replace(/```[\s\S]*?```/g, "").trim();
  const candidate = (noFence || trimmed)
    .replace(/^\s*json\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!candidate) {
    return "我理解了你的问题。你可以直接说具体目标，我会先给你确认再执行。";
  }
  return candidate.slice(0, 160);
}

function sanitizeEvolutionMemory(item: string): string {
  return item.trim().replace(/\s+/g, " ").slice(0, 240);
}

function shouldRetryWithFallbackModel(statusCode: number, apiMessage: string): boolean {
  if (statusCode === 404) {
    return /not found|not supported|unsupported|invalid model/i.test(apiMessage);
  }
  if (statusCode === 429 || statusCode === 503) {
    return true;
  }
  if (statusCode >= 500 && statusCode <= 599) {
    return true;
  }
  return false;
}

function isTransientRequestError(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err ?? "").toLowerCase();
  return /socket hang up|etimedout|timeout|econnreset|eai_again|network|fetch failed/.test(message);
}

export function getGeminiModelCandidates(primaryModel: string): string[] {
  const models = [primaryModel, ...defaultFallbackModels].map((m) => m.trim()).filter(Boolean);
  return Array.from(new Set(models));
}

export class GeminiAssistantAdapter {
  constructor(private readonly options: GeminiAssistantOptions, private readonly logger: Logger) {}

  public async suggestEvolutionMemories(
    failures: string[],
    existingMemories: string[] = []
  ): Promise<string[]> {
    if (failures.length === 0) {
      return [];
    }

    const compactFailures = failures.slice(0, 20).map((f, idx) => `${idx + 1}. ${f}`).join("\n");
    const compactMemories = existingMemories.slice(0, 20).map((m, idx) => `${idx + 1}. ${m}`).join("\n");
    const prompt = [
      "你是一个代码机器人自我改进分析器。",
      "请根据最近失败任务，提取可长期复用的改进记忆。",
      "只输出 JSON，不要 markdown。",
      'JSON schema: {"memories":["..."]}',
      "规则：",
      "- 每条记忆应是可执行/可检查的工程规则。",
      "- 避免重复已有记忆。",
      "- 禁止包含任何密钥、token、密码、个人隐私。",
      "- 记忆条数 0-6 条，每条不超过 120 中文字。",
      `existing_memories:\n${compactMemories || "(none)"}`,
      `recent_failures:\n${compactFailures}`
    ].join("\n");

    const models = this.options.strictModel ? [this.options.model] : getGeminiModelCandidates(this.options.model);
    let lastError: Error | null = null;

    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const hasNext = i < models.length - 1;
      const url =
        `${this.options.apiBaseUrl.replace(/\/+$/, "")}` +
        `/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;

      let response: { statusCode: number; json: GeminiGenerateContentResponse };
      try {
        response = await requestJson<GeminiGenerateContentResponse>({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json"
          },
          body: Buffer.from(
            JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1
              }
            }),
            "utf8"
          ),
          timeoutMs: this.options.timeoutMs,
          proxyUrl: this.options.proxyUrl
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lastError = wrapped;
        if (hasNext && isTransientRequestError(err)) {
          this.logger.warn(
            `Gemini request failed on model ${model}: ${wrapped.message}. Trying fallback model.`
          );
          continue;
        }
        throw wrapped;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const apiMessage = response.json?.error?.message ?? "unknown error";
        const err = new Error(`Gemini API error: HTTP ${response.statusCode} ${apiMessage}`);
        lastError = err;
        if (shouldRetryWithFallbackModel(response.statusCode, apiMessage) && hasNext) {
          this.logger.warn(`Gemini model unavailable: ${model}. Trying fallback model.`);
          continue;
        }
        throw err;
      }

      const raw = extractCandidateText(response.json);
      if (!raw) {
        return [];
      }

      try {
        const parsed = evolutionSchema.parse(tryExtractLooseJson(raw));
        return parsed.memories
          .map((item) => sanitizeEvolutionMemory(item))
          .filter((item) => item.length > 0);
      } catch (err) {
        this.logger.warn(`Gemini evolution parse failed: ${(err as Error).message}`);
        return [];
      }
    }

    if (lastError) {
      throw lastError;
    }
    return [];
  }

  public async interpretUserText(
    text: string,
    defaultRepoId: string | null,
    allowedRepoIds: string[] = [],
    allowLocalPathRepo = false,
    memoryContext: string[] = [],
    recentConversation: string[] = [],
    mode: GeminiInterpretMode = "auto"
  ): Promise<GeminiAssistResult> {
    const prompt = buildPrompt(
      text,
      defaultRepoId,
      allowedRepoIds,
      allowLocalPathRepo,
      memoryContext,
      recentConversation,
      mode
    );
    const models = this.options.strictModel ? [this.options.model] : getGeminiModelCandidates(this.options.model);
    let lastError: Error | null = null;

    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const hasNext = i < models.length - 1;
      const url =
        `${this.options.apiBaseUrl.replace(/\/+$/, "")}` +
        `/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;

      let response: { statusCode: number; json: GeminiGenerateContentResponse };
      try {
        response = await requestJson<GeminiGenerateContentResponse>({
          method: "POST",
          url,
          headers: {
            "Content-Type": "application/json"
          },
          body: Buffer.from(
            JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.1
              }
            }),
            "utf8"
          ),
          timeoutMs: this.options.timeoutMs,
          proxyUrl: this.options.proxyUrl
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lastError = wrapped;
        if (hasNext && isTransientRequestError(err)) {
          this.logger.warn(
            `Gemini request failed on model ${model}: ${wrapped.message}. Trying fallback model.`
          );
          continue;
        }
        throw wrapped;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const apiMessage = response.json?.error?.message ?? "unknown error";
        const err = new Error(`Gemini API error: HTTP ${response.statusCode} ${apiMessage}`);
        lastError = err;
        if (shouldRetryWithFallbackModel(response.statusCode, apiMessage) && hasNext) {
          this.logger.warn(`Gemini model unavailable: ${model}. Trying fallback model.`);
          continue;
        }
        throw err;
      }

      const raw = extractCandidateText(response.json);
      if (!raw) {
        this.logger.warn("Gemini returned empty candidate text.");
        return { command: null, reply: null, memoryToSave: null };
      }

      try {
        const normalized = normalizeGeminiDecision(tryExtractLooseJson(raw));
        if (mode === "reply_only" && normalized.command) {
          return {
            command: null,
            reply: "我先按聊天模式回复。若你要执行任务，请用 /task 或 !codex 前缀命令。",
            memoryToSave: normalized.memoryToSave
          };
        }
        return normalized;
      } catch (err) {
        this.logger.warn(`Gemini decision parse failed: ${(err as Error).message}`);
        return {
          command: null,
          reply: sanitizeReplyText(raw),
          memoryToSave: null
        };
      }
    }

    if (lastError) {
      throw lastError;
    }
    return { command: null, reply: null, memoryToSave: null };
  }
}
