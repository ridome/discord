import fs from "fs";
import os from "os";
import path from "path";
import { RunCommandResult } from "../types";
import { runCommand, runShell } from "../utils/process";

export interface GitEngineOptions {
  commitAuthorName: string;
  commitAuthorEmail: string;
}

export interface AutoStashResult {
  stashed: boolean;
  stashRef: string | null;
  changedCount: number;
  remainingTrackedCount: number;
  remainingUntrackedCount: number;
  remainingPreview: string;
}

export class GitEngine {
  constructor(private readonly options: GitEngineOptions) {}

  private async runGit(repoPath: string, args: string[]): Promise<RunCommandResult> {
    return runCommand("git", args, repoPath);
  }

  public async ensureRepository(repoPath: string): Promise<void> {
    const result = await this.runGit(repoPath, ["rev-parse", "--is-inside-work-tree"]);
    if (result.exitCode !== 0 || !result.stdout.includes("true")) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
  }

  public async ensureCleanWorktree(repoPath: string): Promise<void> {
    const branchResult = await this.runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch =
      branchResult.exitCode === 0
        ? branchResult.stdout.trim() || "(detached)"
        : "(unknown)";

    const summary = await this.getWorktreeSummary(repoPath);
    if (summary.totalCount > 0) {
      const suffix = summary.totalCount > 20 ? `; ... (+${summary.totalCount - 20} more)` : "";
      throw new Error(
        `Working tree is not clean (branch=${branch}, changes=${summary.totalCount}): ${summary.preview}${suffix}. ` +
          "Commit/stash/discard local changes, then retry /approve."
      );
    }
  }

  public async ensureNoTrackedChanges(repoPath: string): Promise<void> {
    const branchResult = await this.runGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch =
      branchResult.exitCode === 0
        ? branchResult.stdout.trim() || "(detached)"
        : "(unknown)";

    const summary = await this.getWorktreeSummary(repoPath);
    if (summary.trackedCount > 0) {
      throw new Error(
        `Tracked changes still exist (branch=${branch}, tracked=${summary.trackedCount}): ${summary.preview}. ` +
          "Please stash/commit/discard tracked changes first."
      );
    }
  }

  public async autoStashDirtyWorktree(repoPath: string, stashMessage: string): Promise<AutoStashResult> {
    const initial = await this.getWorktreeSummary(repoPath);
    if (initial.totalCount === 0) {
      return {
        stashed: false,
        stashRef: null,
        changedCount: 0,
        remainingTrackedCount: 0,
        remainingUntrackedCount: 0,
        remainingPreview: ""
      };
    }

    const beforeTopHash = await this.getTopStashHash(repoPath);
    const stashResult = await this.runGit(repoPath, ["stash", "push", "-u", "-m", stashMessage]);
    const stashOutput = `${stashResult.stdout}\n${stashResult.stderr}`;
    const hasSavedMessage = /saved working directory and index state/i.test(stashOutput);
    if (stashResult.exitCode !== 0 && !hasSavedMessage) {
      throw new Error(`git stash push failed: ${stashResult.stderr || stashResult.stdout}`);
    }

    const afterTopHash = await this.getTopStashHash(repoPath);
    const stashRef = afterTopHash && afterTopHash !== beforeTopHash ? afterTopHash : afterTopHash;

    const remaining = await this.getWorktreeSummary(repoPath);

    return {
      stashed: true,
      stashRef,
      changedCount: initial.totalCount,
      remainingTrackedCount: remaining.trackedCount,
      remainingUntrackedCount: remaining.untrackedCount,
      remainingPreview: remaining.preview
    };
  }

  public async checkoutTaskBranch(
    repoPath: string,
    baseBranch: string,
    taskBranch: string
  ): Promise<void> {
    let result = await this.runGit(repoPath, ["checkout", baseBranch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to checkout base branch ${baseBranch}: ${result.stderr || result.stdout}`);
    }

    result = await this.runGit(repoPath, ["checkout", "-B", taskBranch]);
    if (result.exitCode !== 0) {
      throw new Error(`Failed to create/switch task branch ${taskBranch}: ${result.stderr || result.stdout}`);
    }
  }

  public async applyPatch(repoPath: string, patch: string): Promise<void> {
    const tmpFile = path.join(os.tmpdir(), `codex-apply-${Date.now()}.diff`);
    fs.writeFileSync(tmpFile, patch, "utf8");
    try {
      const applyResult = await this.runGit(repoPath, [
        "apply",
        "--3way",
        "--index",
        "--whitespace=nowarn",
        tmpFile
      ]);
      if (applyResult.exitCode !== 0) {
        throw new Error(`git apply failed: ${applyResult.stderr || applyResult.stdout}`);
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  }

  public async runTestCommands(
    repoPath: string,
    commands: string[],
    onOutput?: (line: string) => void
  ): Promise<{ passed: boolean; lastResult: RunCommandResult | null }> {
    let lastResult: RunCommandResult | null = null;

    for (const command of commands) {
      lastResult = await runShell(command, repoPath, {
        onStdoutLine: (line) => onOutput?.(`[test] ${line}`),
        onStderrLine: (line) => onOutput?.(`[test] ${line}`)
      });

      if (lastResult.exitCode !== 0) {
        return { passed: false, lastResult };
      }
    }

    return { passed: true, lastResult };
  }

  public async commitAll(repoPath: string, message: string): Promise<string> {
    let result = await this.runGit(repoPath, ["add", "-A"]);
    if (result.exitCode !== 0) {
      throw new Error(`git add failed: ${result.stderr || result.stdout}`);
    }

    result = await this.runGit(repoPath, [
      "-c",
      `user.name=${this.options.commitAuthorName}`,
      "-c",
      `user.email=${this.options.commitAuthorEmail}`,
      "commit",
      "-m",
      message
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
    }

    const head = await this.runGit(repoPath, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0) {
      throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
    }

    return head.stdout.trim();
  }

  public async commitStaged(repoPath: string, message: string): Promise<string> {
    const staged = await this.runGit(repoPath, ["diff", "--cached", "--name-only"]);
    if (staged.exitCode !== 0) {
      throw new Error(`git diff --cached failed: ${staged.stderr || staged.stdout}`);
    }
    if (!staged.stdout.trim()) {
      throw new Error("No staged changes to commit.");
    }

    const result = await this.runGit(repoPath, [
      "-c",
      `user.name=${this.options.commitAuthorName}`,
      "-c",
      `user.email=${this.options.commitAuthorEmail}`,
      "commit",
      "-m",
      message
    ]);

    if (result.exitCode !== 0) {
      throw new Error(`git commit failed: ${result.stderr || result.stdout}`);
    }

    const head = await this.runGit(repoPath, ["rev-parse", "HEAD"]);
    if (head.exitCode !== 0) {
      throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
    }

    return head.stdout.trim();
  }

  public async runCommand(repoPath: string, command: string): Promise<RunCommandResult> {
    return runShell(command, repoPath);
  }

  private async getPorcelainStatusLines(repoPath: string): Promise<string[]> {
    const status = await this.runGit(repoPath, ["status", "--porcelain"]);
    if (status.exitCode !== 0) {
      throw new Error(`git status failed: ${status.stderr || status.stdout}`);
    }
    return status.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  }

  private async getWorktreeSummary(repoPath: string): Promise<{
    totalCount: number;
    trackedCount: number;
    untrackedCount: number;
    preview: string;
  }> {
    const lines = await this.getPorcelainStatusLines(repoPath);
    const tracked = lines.filter((line) => !line.startsWith("?? "));
    const untracked = lines.filter((line) => line.startsWith("?? "));
    return {
      totalCount: lines.length,
      trackedCount: tracked.length,
      untrackedCount: untracked.length,
      preview: lines.slice(0, 20).join("; ")
    };
  }

  private async getTopStashHash(repoPath: string): Promise<string | null> {
    const result = await this.runGit(repoPath, ["stash", "list", "--format=%H"]);
    if (result.exitCode !== 0) {
      return null;
    }
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    return first ?? null;
  }
}
