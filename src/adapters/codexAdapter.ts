import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { z } from "zod";
import { CodexPatchResult } from "../types";
import { runCommand } from "../utils/process";

const outputSchema = z.object({
  summary: z.string().min(1),
  patch: z.string().min(1),
  test_commands: z.array(z.string()).default([]),
  risk_notes: z.array(z.string()).default([])
});

function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    throw new Error("Empty Codex output");
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }

  return JSON.parse(text);
}

export interface CodexGenerateInput {
  repoPath: string;
  userPrompt: string;
  timeoutMs: number;
  onStream?: (message: string) => void;
}

export interface CodexAdapterOptions {
  executable: string | null;
}

export class CodexAdapter {
  private cachedExecutable: string | null = null;

  constructor(private readonly options: CodexAdapterOptions) {}

  public async generatePatch(input: CodexGenerateInput): Promise<CodexPatchResult> {
    if (!fs.existsSync(input.repoPath)) {
      throw new Error(`Repo path not found: ${input.repoPath}`);
    }
    if (!fs.statSync(input.repoPath).isDirectory()) {
      throw new Error(`Repo path is not a directory: ${input.repoPath}`);
    }

    const schemaPath = path.join(os.tmpdir(), `codex-schema-${Date.now()}.json`);
    const outputPath = path.join(os.tmpdir(), `codex-output-${Date.now()}.json`);

    const schemaDoc = {
      type: "object",
      additionalProperties: false,
      required: ["summary", "patch", "test_commands", "risk_notes"],
      properties: {
        summary: { type: "string" },
        patch: { type: "string" },
        test_commands: {
          type: "array",
          items: { type: "string" }
        },
        risk_notes: {
          type: "array",
          items: { type: "string" }
        }
      }
    };

    fs.writeFileSync(schemaPath, JSON.stringify(schemaDoc), "utf8");

    const prompt = [
      "Generate a single unified diff patch for the current git repository.",
      "Do not execute shell commands.",
      "Patch paths must be repository-relative.",
      "Respond in strict JSON that matches the provided output schema.",
      "The patch must be directly applicable via git apply.",
      `User task: ${input.userPrompt}`
    ].join("\n");

    try {
      const codexExecutable = this.resolveCodexExecutable();
      const result = await runCommand(
        codexExecutable,
        [
          "exec",
          "--json",
          "-s",
          "read-only",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          "-C",
          input.repoPath,
          prompt
        ],
        input.repoPath,
        {
          onStdoutLine: (line) => this.handleEventLine(line, input.onStream),
          onStderrLine: (line) => input.onStream?.(`[codex-stderr] ${line}`)
        },
        input.timeoutMs
      );

      if (result.exitCode !== 0) {
        throw new Error(`codex exec failed: ${result.stderr || result.stdout}`);
      }

      if (!fs.existsSync(outputPath)) {
        throw new Error("Codex output file missing");
      }

      const raw = fs.readFileSync(outputPath, "utf8");
      const parsed = extractJson(raw);
      return outputSchema.parse(parsed);
    } catch (err: any) {
      if (err && err.code === "ENOENT") {
        if (!fs.existsSync(input.repoPath)) {
          throw new Error(
            `Repo path not found: ${input.repoPath}. Update config/repos.json and restart bot.`
          );
        }
        throw new Error(
          "Failed to launch Codex process (ENOENT). Verify CODEX_EXECUTABLE and that codex.exe exists, e.g. " +
            "C:\\Users\\<you>\\.vscode\\extensions\\openai.chatgpt-<version>-win32-x64\\bin\\windows-x86_64\\codex.exe"
        );
      }
      throw err;
    } finally {
      try {
        fs.unlinkSync(schemaPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(outputPath);
      } catch {
        // ignore
      }
    }
  }

  private resolveCodexExecutable(): string {
    if (this.cachedExecutable) {
      return this.cachedExecutable;
    }

    if (this.options.executable) {
      const explicit = this.resolveCommand(this.options.executable);
      if (!explicit) {
        throw new Error(`CODEX_EXECUTABLE is set but not found: ${this.options.executable}`);
      }
      this.cachedExecutable = explicit;
      return explicit;
    }

    const commandCandidates =
      process.platform === "win32" ? ["codex", "codex.exe", "codex.cmd"] : ["codex"];

    for (const candidate of commandCandidates) {
      const resolved = this.resolveCommand(candidate);
      if (resolved) {
        this.cachedExecutable = resolved;
        return resolved;
      }
    }

    const fromExtension = this.findCodexFromVsCodeExtension();
    if (fromExtension) {
      this.cachedExecutable = fromExtension;
      return fromExtension;
    }

    throw new Error(
      "Unable to locate codex executable. Install Codex CLI or set CODEX_EXECUTABLE in .env to codex.exe path."
    );
  }

  private resolveCommand(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) {
      return null;
    }

    if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
      const absolute = path.isAbsolute(trimmed) ? trimmed : path.resolve(trimmed);
      return fs.existsSync(absolute) ? absolute : null;
    }

    const lookupCmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(lookupCmd, [trimmed], {
      encoding: "utf8",
      windowsHide: true
    });

    if (result.status === 0 && result.stdout) {
      const firstLine = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
      if (firstLine) {
        return firstLine;
      }
    }

    return null;
  }

  private findCodexFromVsCodeExtension(): string | null {
    const home = os.homedir();
    const extensionRoots = [
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions")
    ];

    const platformRelativeCandidates =
      process.platform === "win32"
        ? [
            path.join("bin", "windows-x86_64", "codex.exe"),
            path.join("bin", "windows-aarch64", "codex.exe")
          ]
        : process.platform === "darwin"
          ? [
              path.join("bin", "macos-aarch64", "codex"),
              path.join("bin", "macos-x86_64", "codex")
            ]
          : [
              path.join("bin", "linux-x86_64", "codex"),
              path.join("bin", "linux-aarch64", "codex")
            ];

    for (const root of extensionRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }

      const dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith("openai.chatgpt-"))
        .map((d) => path.join(root, d.name))
        .sort((a, b) => b.localeCompare(a));

      for (const dir of dirs) {
        for (const rel of platformRelativeCandidates) {
          const fullPath = path.join(dir, rel);
          if (fs.existsSync(fullPath)) {
            return fullPath;
          }
        }
      }
    }

    return null;
  }

  private handleEventLine(line: string, onStream?: (message: string) => void): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as any;
      if (event.type === "item.completed" && event.item?.text) {
        const text = String(event.item.text).trim();
        if (!text) {
          return;
        }

        // Skip verbose model self-commentary and final JSON echo; approval card already shows structured output.
        if (/^\*\*.*\*\*$/s.test(text)) {
          return;
        }
        if (/^\{[\s\S]*"summary"[\s\S]*"patch"[\s\S]*"test_commands"[\s\S]*\}$/s.test(text)) {
          return;
        }

        onStream?.(`[codex] ${text}`);
        return;
      }
      if (event.type === "item.completed" && event.item?.type === "command_execution") {
        const status = event.item.status ?? "unknown";
        const cmd = event.item.command ?? "";
        onStream?.(`[codex-cmd:${status}] ${cmd}`);
        return;
      }
      if (event.type === "turn.completed" && event.usage) {
        onStream?.(
          `[codex] turn completed (input=${event.usage.input_tokens}, output=${event.usage.output_tokens})`
        );
      }
    } catch {
      // ignore line-level parse errors
    }
  }
}
