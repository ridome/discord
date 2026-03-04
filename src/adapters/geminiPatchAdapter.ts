import fs from "fs";
import path from "path";
import { z } from "zod";
import { CodexPatchResult } from "../types";
import { Logger } from "../logger";
import { requestJson } from "../utils/http";
import { runCommand } from "../utils/process";
import { getGeminiModelCandidates } from "./geminiAssistantAdapter";
import { PatchGenerateInput, PatchGenerator } from "./patchGenerator";

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

export interface GeminiPatchAdapterOptions {
  apiKey: string;
  model: string;
  apiBaseUrl: string;
  timeoutMs: number;
  strictModel: boolean;
  proxyUrl?: string | null;
}

const patchSchema = z.object({
  summary: z.string().min(1),
  patch: z.string().min(1),
  test_commands: z.array(z.string()).default([]),
  risk_notes: z.array(z.string()).default([])
});

function extractCandidateText(response: GeminiGenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => String(part.text ?? ""))
    .join("")
    .trim();
}

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

function extractHintTokens(text: string): string[] {
  const tokens = text.match(/[A-Za-z0-9._/\-\\]{3,}/g) ?? [];
  const normalized = tokens
    .map((token) => token.replace(/\\/g, "/").toLowerCase())
    .filter((token) => !/^(https?|task|repo|prompt|fix|add|update|create|with|from)$/i.test(token));
  return Array.from(new Set(normalized)).slice(0, 20);
}

function pickContextFiles(files: string[], userPrompt: string): string[] {
  const lower = files.map((item) => item.toLowerCase());
  const byName = new Set<string>();
  const preferred = [
    "readme.md",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "cargo.toml"
  ];

  for (const name of preferred) {
    const idx = lower.findIndex((item) => item.endsWith(`/${name}`) || item === name);
    if (idx >= 0) {
      byName.add(files[idx]);
    }
  }

  const tokens = extractHintTokens(userPrompt);
  for (let i = 0; i < files.length; i += 1) {
    const pathLower = lower[i];
    if (tokens.some((token) => pathLower.includes(token))) {
      byName.add(files[i]);
    }
    if (byName.size >= 10) {
      break;
    }
  }

  return Array.from(byName).slice(0, 10);
}

async function collectRepoContext(
  repoPath: string,
  userPrompt: string
): Promise<{ fileListPreview: string; snippetPreview: string }> {
  let files: string[] = [];
  try {
    const result = await runCommand("git", ["ls-files"], repoPath, undefined, 15000);
    if (result.exitCode === 0) {
      files = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }
  } catch {
    // ignore, keep empty context
  }

  const fileListPreview = files.length
    ? [
        ...files.slice(0, 300),
        ...(files.length > 300 ? [`... (+${files.length - 300} more files)`] : [])
      ].join("\n")
    : "(no tracked files detected)";

  if (!files.length) {
    return {
      fileListPreview,
      snippetPreview: "(no file snippets)"
    };
  }

  const candidates = pickContextFiles(files, userPrompt);
  const snippets: string[] = [];
  let budget = 0;
  const maxBudget = 14000;

  for (const relativePath of candidates) {
    const fullPath = path.resolve(repoPath, relativePath);
    if (!fullPath.startsWith(path.resolve(repoPath))) {
      continue;
    }
    if (!fs.existsSync(fullPath)) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 256 * 1024) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }

    if (content.includes("\u0000")) {
      continue;
    }

    const clipped = content.slice(0, 3000);
    const block =
      `FILE: ${relativePath}\n` +
      "```text\n" +
      `${clipped}${content.length > clipped.length ? "\n...[truncated]" : ""}\n` +
      "```";
    if (budget + block.length > maxBudget) {
      break;
    }
    budget += block.length;
    snippets.push(block);
  }

  return {
    fileListPreview,
    snippetPreview: snippets.length ? snippets.join("\n\n") : "(no file snippets)"
  };
}

function buildPrompt(
  input: PatchGenerateInput,
  context: { fileListPreview: string; snippetPreview: string }
): string {
  return [
    "You are a software engineer that writes repository patches.",
    "Return STRICT JSON only. No markdown, no prose outside JSON.",
    'JSON schema: {"summary":"string","patch":"string","test_commands":["string"],"risk_notes":["string"]}',
    "Rules:",
    "- patch must be a valid unified diff (git format).",
    "- patch paths must be repo-root relative.",
    "- do not use absolute paths, .., or .git paths.",
    "- do not execute commands.",
    "- keep changes focused on user task.",
    "- if context is insufficient, produce a minimal safe patch and explain assumptions in risk_notes.",
    "- test_commands should be directly runnable shell commands (no placeholders like <patch-file>).",
    `user_task=${input.userPrompt}`,
    "repo_files_preview:",
    context.fileListPreview,
    "repo_snippets:",
    context.snippetPreview
  ].join("\n");
}

export class GeminiPatchAdapter implements PatchGenerator {
  public readonly providerId = "gemini";
  public readonly displayName = "Gemini";

  constructor(private readonly options: GeminiPatchAdapterOptions, private readonly logger: Logger) {}

  public async generatePatch(input: PatchGenerateInput): Promise<CodexPatchResult> {
    if (!fs.existsSync(input.repoPath)) {
      throw new Error(`Repo path not found: ${input.repoPath}`);
    }
    if (!fs.statSync(input.repoPath).isDirectory()) {
      throw new Error(`Repo path is not a directory: ${input.repoPath}`);
    }

    const repoContext = await collectRepoContext(input.repoPath, input.userPrompt);
    const prompt = buildPrompt(input, repoContext);
    const models = this.options.strictModel ? [this.options.model] : getGeminiModelCandidates(this.options.model);
    let lastError: Error | null = null;

    for (let i = 0; i < models.length; i += 1) {
      const model = models[i];
      const hasNext = i < models.length - 1;
      const url =
        `${this.options.apiBaseUrl.replace(/\/+$/, "")}` +
        `/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.options.apiKey)}`;
      input.onStream?.(`[gemini] generating patch with model=${model}`);

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
          timeoutMs: Math.max(input.timeoutMs, this.options.timeoutMs),
          proxyUrl: this.options.proxyUrl
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lastError = wrapped;
        if (hasNext && isTransientRequestError(err)) {
          this.logger.warn(
            `Gemini patch request failed on model ${model}: ${wrapped.message}. Trying fallback model.`
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
          this.logger.warn(`Gemini patch model unavailable: ${model}. Trying fallback model.`);
          continue;
        }
        throw err;
      }

      const raw = extractCandidateText(response.json);
      if (!raw) {
        const err = new Error("Gemini returned empty patch output.");
        lastError = err;
        if (hasNext) {
          this.logger.warn(`Gemini patch output empty on model ${model}. Trying fallback model.`);
          continue;
        }
        throw err;
      }

      try {
        const parsed = patchSchema.parse(tryExtractLooseJson(raw));
        input.onStream?.(`[gemini] patch generated (model=${model})`);
        return parsed;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        lastError = wrapped;
        if (hasNext) {
          this.logger.warn(`Gemini patch parse failed on model ${model}: ${wrapped.message}`);
          continue;
        }
        throw wrapped;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("Gemini patch generation failed with unknown error.");
  }
}
