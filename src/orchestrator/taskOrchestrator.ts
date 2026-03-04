import EventEmitter from "events";
import { CodexAdapter } from "../adapters/codexAdapter";
import { Logger } from "../logger";
import { CommandGuard } from "../security/commandGuard";
import { RepoRegistry } from "../security/repoRegistry";
import { GitEngine } from "../engines/gitEngine";
import { PatchEngine } from "../engines/patchEngine";
import { VSCodeBridge } from "../engines/vscodeBridge";
import { StateStore } from "../store/stateStore";
import {
  PendingConfirmation,
  RunCommandResult,
  TaskRecord,
  TaskUpdateEvent
} from "../types";
import { expiresInMinutes, newTaskId, newToken, nowIso } from "../utils/time";
import { RepoLockManager } from "./repoLockManager";
import { selectTestCommands } from "./testCommandSelector";
import { buildExecutionPlan } from "./planBuilder";

interface TaskRequest {
  repoId: string;
  prompt: string;
  requesterUserId: string;
  requesterChannelId: string;
  baseBranch?: string;
  testProfile?: string;
  openVsCode?: boolean;
}

interface OrchestratorOptions {
  planApprovalRequired: boolean;
  taskTimeoutMinutes: number;
  streamThrottleSeconds: number;
  codexRetryCount: number;
  autoStashBeforeApply: boolean;
}

interface StreamBuffer {
  lines: string[];
  timer: NodeJS.Timeout | null;
}

export class TaskOrchestrator {
  private static readonly TASK_ARTIFACT_DIR = "bot_tasks";
  private readonly emitter = new EventEmitter();
  private readonly repoLocks = new RepoLockManager();
  private readonly streamBuffers = new Map<string, StreamBuffer>();
  private readonly runtimeOptions = new Map<string, { openVsCode: boolean }>();
  private readonly approvalInFlight = new Set<string>();

  constructor(
    private readonly store: StateStore,
    private readonly repoRegistry: RepoRegistry,
    private readonly codexAdapter: CodexAdapter,
    private readonly patchEngine: PatchEngine,
    private readonly gitEngine: GitEngine,
    private readonly commandGuard: CommandGuard,
    private readonly vscodeBridge: VSCodeBridge,
    private readonly logger: Logger,
    private readonly options: OrchestratorOptions
  ) {}

  public onUpdate(listener: (event: TaskUpdateEvent) => void): void {
    this.emitter.on("task-update", listener);
  }

  public createTask(input: TaskRequest): TaskRecord {
    const repo = this.repoRegistry.get(input.repoId);
    const taskId = newTaskId();
    const baseBranch = input.baseBranch ?? repo.defaultBaseBranch;

    const task = this.store.createTask(taskId, {
      repoId: repo.id,
      requesterDiscordUserId: input.requesterUserId,
      requesterChannelId: input.requesterChannelId,
      prompt: input.prompt,
      baseBranch,
      testProfile: input.testProfile ?? null,
      branchName: `bot/task-${taskId}`
    });

    this.runtimeOptions.set(taskId, { openVsCode: input.openVsCode ?? false });
    this.log(task, "milestone", `Task created for repo ${repo.id}`);

    if (this.options.planApprovalRequired) {
      this.store.updateTaskStatus(taskId, "awaiting_plan_approval");
      const plan = buildExecutionPlan({
        repoId: repo.id,
        baseBranch,
        branchName: task.branchName,
        prompt: task.prompt,
        testProfile: task.testProfile,
        openVsCode: input.openVsCode ?? false
      });
      this.emit({
        taskId,
        channelId: task.requesterChannelId,
        level: "plan",
        message: "Execution plan ready for approval",
        metadata: {
          summary: plan.summary,
          steps: plan.steps,
          notes: plan.notes,
          repoId: repo.id,
          baseBranch,
          branchName: task.branchName
        }
      });
      this.store.addTaskEvent(taskId, "plan", `Plan ready: ${plan.summary}`);
    } else {
      void this.repoLocks.runExclusive(repo.id, async () => {
        await this.processTask(taskId);
      });
    }

    return this.store.getTaskOrThrow(taskId);
  }

  public getStatus(taskId: string): { task: TaskRecord; events: Array<{ level: string; message: string; createdAt: string }> } {
    const task = this.store.getTaskOrThrow(taskId);
    const events = this.store.getRecentTaskEvents(taskId, 20);
    return { task, events };
  }

  public async approveTask(taskId: string, approverUserId: string): Promise<TaskRecord> {
    const firstSeen = this.store.getTaskOrThrow(taskId);
    if (
      firstSeen.status !== "awaiting_plan_approval" &&
      firstSeen.status !== "awaiting_approval" &&
      firstSeen.status !== "ready_to_commit"
    ) {
      throw new Error(`Task ${taskId} is not approvable in status ${firstSeen.status}`);
    }

    if (this.approvalInFlight.has(taskId)) {
      throw new Error(`Task ${taskId} approval is already running.`);
    }

    this.approvalInFlight.add(taskId);
    const approvalAction = firstSeen.status === "awaiting_plan_approval" ? "approve_plan" : "approve";
    this.store.addApproval(taskId, approvalAction, approverUserId, {});

    try {
      await this.repoLocks.runExclusive(firstSeen.repoId, async () => {
        const latest = this.store.getTaskOrThrow(taskId);
        if (latest.status === "awaiting_plan_approval") {
          this.log(latest, "milestone", "Plan approved. Starting execution...");
          await this.processTask(taskId);
          return;
        }
        if (latest.status === "awaiting_approval") {
          await this.applyAndMaybeCommit(taskId);
          return;
        }
        if (latest.status === "ready_to_commit") {
          await this.commitExistingChanges(taskId);
          return;
        }
        throw new Error(`Task ${taskId} is not approvable in status ${latest.status}`);
      });
    } finally {
      this.approvalInFlight.delete(taskId);
    }

    return this.store.getTaskOrThrow(taskId);
  }

  public rejectTask(taskId: string, approverUserId: string, reason?: string): TaskRecord {
    const task = this.store.getTaskOrThrow(taskId);
    this.store.addApproval(taskId, "reject", approverUserId, { reason: reason ?? "" });
    this.store.updateTaskStatus(taskId, "cancelled");
    if (task.status === "awaiting_plan_approval") {
      this.log(task, "milestone", reason ? `Plan rejected: ${reason}` : "Plan rejected");
    } else {
      this.log(task, "milestone", reason ? `Task rejected: ${reason}` : "Task rejected");
    }
    return this.store.getTaskOrThrow(taskId);
  }

  public cancelTask(taskId: string, requesterUserId: string): TaskRecord {
    const task = this.store.getTaskOrThrow(taskId);
    this.store.addApproval(taskId, "cancel", requesterUserId, {});
    this.store.updateTaskStatus(taskId, "cancelled");
    this.log(task, "milestone", "Task cancelled");
    return this.store.getTaskOrThrow(taskId);
  }

  public async runCommand(
    taskId: string,
    userId: string,
    channelId: string,
    command: string
  ): Promise<
    | { type: "executed"; result: RunCommandResult }
    | { type: "needs_confirmation"; token: string }
  > {
    const task = this.store.getTaskOrThrow(taskId);
    const repo = this.repoRegistry.get(task.repoId);

    if (this.commandGuard.isDangerous(command)) {
      const pending: PendingConfirmation = {
        token: newToken(),
        taskId,
        userId,
        channelId,
        actionType: "danger_command",
        payload: { command },
        expiresAt: expiresInMinutes(10),
        createdAt: nowIso()
      };
      this.store.savePendingConfirmation(pending);
      this.emit({
        taskId,
        channelId,
        level: "danger_confirm",
        message: `Dangerous command requires confirmation: ${command}`,
        metadata: { token: pending.token, command }
      });
      return { type: "needs_confirmation", token: pending.token };
    }

    const result = await this.gitEngine.runCommand(repo.path, command);
    this.log(task, "milestone", `Command executed (exit=${result.exitCode})`);
    return { type: "executed", result };
  }

  public async confirmDangerousCommand(token: string, userId: string): Promise<RunCommandResult> {
    const pending = this.store.getPendingConfirmation(token);
    if (!pending) {
      throw new Error("Confirmation token not found or expired");
    }
    if (pending.userId !== userId) {
      throw new Error("Only the requester can confirm this command");
    }
    if (new Date(pending.expiresAt).getTime() < Date.now()) {
      this.store.deletePendingConfirmation(token);
      throw new Error("Confirmation token expired");
    }

    const command = String(pending.payload.command ?? "");
    const task = this.store.getTaskOrThrow(pending.taskId);
    const repo = this.repoRegistry.get(task.repoId);
    const result = await this.gitEngine.runCommand(repo.path, command);
    this.store.deletePendingConfirmation(token);
    this.log(task, "milestone", `Danger command executed (exit=${result.exitCode})`);
    return result;
  }

  public async openInVSCode(taskId: string): Promise<void> {
    const task = this.store.getTaskOrThrow(taskId);
    const repo = this.repoRegistry.get(task.repoId);
    await this.vscodeBridge.openRepo(repo.path);
    if (task.firstChangedFile) {
      await this.vscodeBridge.openFile(repo.path, task.firstChangedFile, 1);
    }
  }

  public listRepos(): Array<{ id: string; path: string; defaultBaseBranch: string; profiles: string[] }> {
    return this.repoRegistry.list().map((repo) => ({
      id: repo.id,
      path: repo.path,
      defaultBaseBranch: repo.defaultBaseBranch,
      profiles: Object.keys(repo.testProfiles)
    }));
  }

  public createNlConfirmation(
    taskId: string,
    userId: string,
    channelId: string,
    payload: Record<string, unknown>
  ): string {
    const token = newToken();
    this.store.savePendingConfirmation({
      token,
      taskId,
      userId,
      channelId,
      actionType: "nl_command",
      payload,
      expiresAt: expiresInMinutes(5),
      createdAt: nowIso()
    });
    return token;
  }

  public consumeNlConfirmation(token: string, userId: string): PendingConfirmation {
    const pending = this.store.getPendingConfirmation(token);
    if (!pending) {
      throw new Error("Confirmation token not found or expired");
    }
    if (pending.actionType !== "nl_command") {
      throw new Error("Token type mismatch");
    }
    if (pending.userId !== userId) {
      throw new Error("Only the requester can confirm");
    }
    if (new Date(pending.expiresAt).getTime() < Date.now()) {
      this.store.deletePendingConfirmation(token);
      throw new Error("Confirmation token expired");
    }
    this.store.deletePendingConfirmation(token);
    return pending;
  }

  public cancelPendingConfirmation(token: string, userId: string): void {
    const pending = this.store.getPendingConfirmation(token);
    if (!pending) {
      return;
    }
    if (pending.userId !== userId) {
      throw new Error("Only requester can cancel this confirmation");
    }
    this.store.deletePendingConfirmation(token);
  }

  private async processTask(taskId: string): Promise<void> {
    const task = this.store.getTaskOrThrow(taskId);
    const repo = this.repoRegistry.get(task.repoId);
    const runtime = this.runtimeOptions.get(taskId) ?? { openVsCode: false };

    this.store.updateTaskStatus(taskId, "generating_patch");
    this.log(task, "milestone", "Generating patch with Codex...");

    if (runtime.openVsCode) {
      try {
        await this.vscodeBridge.openRepo(repo.path);
      } catch (err) {
        this.log(task, "stream", `VS Code open failed: ${(err as Error).message}`);
      }
    }

    let lastErr: Error | null = null;
    const attempts = Math.max(1, this.options.codexRetryCount + 1);

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const patchResult = await this.codexAdapter.generatePatch({
          repoPath: repo.path,
          userPrompt: task.prompt,
          timeoutMs: this.options.taskTimeoutMinutes * 60 * 1000,
          onStream: (line) => this.stream(task, line)
        });

        const patchWithArtifact = this.ensureTaskArtifactFile(
          task,
          patchResult.summary,
          patchResult.patch
        );
        const validation = await this.patchEngine.validateAndPrecheck(repo.path, patchWithArtifact);
        if (!validation.ok) {
          throw new Error(`Patch validation failed: ${validation.errors.join("; ")}`);
        }

        this.store.updatePatchResult(
          taskId,
          patchResult.summary,
          patchWithArtifact,
          patchResult.test_commands,
          patchResult.risk_notes,
          validation.firstChangedFile
        );
        this.store.updateTaskStatus(taskId, "awaiting_approval");

        this.log(
          task,
          "milestone",
          `Patch ready: ${validation.changedFiles.length} files, +${validation.addedLines}/-${validation.deletedLines}`
        );

        this.emit({
          taskId,
          channelId: task.requesterChannelId,
          level: "approval",
          message: "Patch is ready for approval",
          metadata: {
            summary: patchResult.summary,
            changedFiles: validation.changedFiles,
            addedLines: validation.addedLines,
            deletedLines: validation.deletedLines,
            riskNotes: patchResult.risk_notes
          }
        });

        this.flushTaskStream(task.taskId, task.requesterChannelId);
        return;
      } catch (err) {
        lastErr = err as Error;
        this.log(task, "stream", `Patch generation attempt ${attempt} failed: ${lastErr.message}`);
      }
    }

    this.store.updateTaskStatus(taskId, "failed", lastErr?.message ?? "Unknown failure");
    this.log(task, "error", `Task failed: ${lastErr?.message ?? "unknown"}`);
    this.flushTaskStream(task.taskId, task.requesterChannelId);
  }

  private async applyAndMaybeCommit(taskId: string): Promise<void> {
    const task = this.store.getTaskOrThrow(taskId);
    const repo = this.repoRegistry.get(task.repoId);
    let autoStashRef: string | null = null;

    if (!task.patch) {
      throw new Error(`Task ${taskId} has no patch`);
    }

    try {
      this.store.updateTaskStatus(taskId, "applying_patch");
      this.log(task, "milestone", "Applying patch...");

      await this.gitEngine.ensureRepository(repo.path);
      if (this.options.autoStashBeforeApply) {
        const stashResult = await this.gitEngine.autoStashDirtyWorktree(
          repo.path,
          `bot-auto-stash:${task.taskId}`
        );
        if (stashResult.stashed) {
          autoStashRef = stashResult.stashRef;
          this.log(
            task,
            "milestone",
            `Detected dirty worktree (${stashResult.changedCount} changes). Auto-stashed local changes${
              autoStashRef ? ` as ${autoStashRef}` : ""
            }.`
          );
          if (stashResult.remainingUntrackedCount > 0) {
            this.log(
              task,
              "stream",
              `Auto-stash left ${stashResult.remainingUntrackedCount} untracked path(s): ${stashResult.remainingPreview}`
            );
          }
          if (stashResult.remainingTrackedCount > 0) {
            throw new Error(
              `Auto-stash left tracked changes (${stashResult.remainingTrackedCount}): ${stashResult.remainingPreview}`
            );
          }
        }
      }
      await this.gitEngine.ensureNoTrackedChanges(repo.path);
      await this.gitEngine.checkoutTaskBranch(repo.path, task.baseBranch, task.branchName);
      await this.gitEngine.ensureNoTrackedChanges(repo.path);
      await this.gitEngine.applyPatch(repo.path, task.patch);

      const testSelection = this.resolveTestCommands(task.repoId, task.testProfile, task.testCommands);
      if (testSelection.droppedSuggested.length > 0) {
        this.log(
          task,
          "stream",
          `Ignored ${testSelection.droppedSuggested.length} unsupported suggested test command(s).`
        );
      }
      const tests = testSelection.commands;
      if (tests.length > 0) {
        this.store.updateTaskStatus(taskId, "running_tests");
        this.log(task, "milestone", `Running tests (${tests.length} command(s))...`);

        const testResult = await this.gitEngine.runTestCommands(repo.path, tests, (line) => {
          this.stream(task, line);
        });

        if (!testResult.passed) {
          this.store.updateTaskStatus(taskId, "ready_to_commit");
          this.log(task, "milestone", "Tests failed. Changes kept for manual decision.");
          this.flushTaskStream(task.taskId, task.requesterChannelId);
          return;
        }
      }

      this.store.updateTaskStatus(taskId, "ready_to_commit");
      const commitMessage = this.buildCommitMessage(task.summary ?? "Task update");
      const commitHash = await this.gitEngine.commitStaged(repo.path, commitMessage);
      this.store.setCommitted(taskId, commitHash);
      this.store.updateTaskStatus(taskId, "committed");

      this.log(task, "milestone", `Committed to ${task.branchName}: ${commitHash}`);
      if (autoStashRef) {
        this.log(
          task,
          "milestone",
          `Auto-stashed changes kept in stash ${autoStashRef}. Restore manually when needed: git stash pop ${autoStashRef}`
        );
      }
      this.flushTaskStream(task.taskId, task.requesterChannelId);
    } catch (err) {
      const message = (err as Error).message;
      if (
        message.includes("Working tree is not clean") ||
        message.includes("Tracked changes still exist") ||
        message.includes("Auto-stash left tracked changes")
      ) {
        this.store.updateTaskStatus(taskId, "awaiting_approval", message);
        this.log(task, "error", `Apply blocked: ${message}`);
        if (autoStashRef) {
          this.log(
            task,
            "milestone",
            `Auto-stashed changes kept in stash ${autoStashRef}. Restore manually when needed: git stash pop ${autoStashRef}`
          );
        }
        this.flushTaskStream(task.taskId, task.requesterChannelId);
        return;
      }

      this.store.updateTaskStatus(taskId, "failed", message);
      this.log(task, "error", `Apply/commit failed: ${message}`);
      if (autoStashRef) {
        this.log(
          task,
          "milestone",
          `Auto-stashed changes kept in stash ${autoStashRef}. Restore manually when needed: git stash pop ${autoStashRef}`
        );
      }
      this.flushTaskStream(task.taskId, task.requesterChannelId);
    }
  }

  private async commitExistingChanges(taskId: string): Promise<void> {
    const task = this.store.getTaskOrThrow(taskId);
    const repo = this.repoRegistry.get(task.repoId);

    try {
      this.log(task, "milestone", "Committing existing changes...");
      const commitMessage = this.buildCommitMessage(task.summary ?? "Task update");
      const commitHash = await this.gitEngine.commitStaged(repo.path, commitMessage);
      this.store.setCommitted(taskId, commitHash);
      this.store.updateTaskStatus(taskId, "committed");
      this.log(task, "milestone", `Committed to ${task.branchName}: ${commitHash}`);
    } catch (err) {
      this.store.updateTaskStatus(taskId, "failed", (err as Error).message);
      this.log(task, "error", `Commit failed: ${(err as Error).message}`);
    }
  }

  private resolveTestCommands(
    repoId: string,
    testProfile: string | null,
    codexCommands: string[]
  ): { commands: string[]; droppedSuggested: string[]; source: "profile" | "codex" | "default" | "none" } {
    const repo = this.repoRegistry.get(repoId);
    return selectTestCommands(testProfile, repo.testProfiles, codexCommands);
  }

  private buildCommitMessage(summary: string): string {
    const firstLine = summary.split(/\r?\n/)[0].trim();
    const short = firstLine.length > 68 ? `${firstLine.slice(0, 68)}...` : firstLine;
    return `bot(task): ${short}`;
  }

  private ensureTaskArtifactFile(task: TaskRecord, summary: string, patch: string): string {
    const artifactPath = `${TaskOrchestrator.TASK_ARTIFACT_DIR}/${task.taskId}.md`;
    const marker = `diff --git a/${artifactPath} b/${artifactPath}`;
    if (patch.includes(marker)) {
      return patch;
    }

    const artifactPatch = this.buildTaskArtifactPatch(task, summary, artifactPath);
    return `${patch.trimEnd()}\n\n${artifactPatch}`;
  }

  private buildTaskArtifactPatch(task: TaskRecord, summary: string, artifactPath: string): string {
    const lines = [
      "# Task Artifact",
      "",
      `- task_id: ${task.taskId}`,
      `- repo_id: ${task.repoId}`,
      `- branch: ${task.branchName}`,
      `- generated_at: ${nowIso()}`,
      "",
      "## Prompt",
      ...(task.prompt ? task.prompt.split(/\r?\n/) : ["(empty)"]),
      "",
      "## Codex Summary",
      ...(summary ? summary.split(/\r?\n/) : ["(empty)"])
    ];

    const hunkBody = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${artifactPath} b/${artifactPath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${artifactPath}`,
      `@@ -0,0 +${lines.length} @@`,
      hunkBody
    ].join("\n");
  }

  private stream(task: TaskRecord, line: string): void {
    const key = task.taskId;
    const existing = this.streamBuffers.get(key) ?? { lines: [], timer: null };
    existing.lines.push(line);

    if (!existing.timer) {
      existing.timer = setTimeout(() => {
        this.flushTaskStream(task.taskId, task.requesterChannelId);
      }, this.options.streamThrottleSeconds * 1000);
    }

    this.streamBuffers.set(key, existing);
  }

  private flushTaskStream(taskId: string, channelId: string): void {
    const state = this.streamBuffers.get(taskId);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
    }

    const message = state.lines.join("\n").trim();
    this.streamBuffers.delete(taskId);

    if (!message) {
      return;
    }

    this.emit({
      taskId,
      channelId,
      level: "stream",
      message
    });

    this.store.addTaskEvent(taskId, "stream", message);
  }

  private log(task: TaskRecord, level: TaskUpdateEvent["level"], message: string): void {
    this.store.addTaskEvent(task.taskId, level, message);
    this.emit({
      taskId: task.taskId,
      channelId: task.requesterChannelId,
      level,
      message
    });
    this.logger.info(`[${task.taskId}] ${message}`);
  }

  private emit(event: TaskUpdateEvent): void {
    this.emitter.emit("task-update", event);
  }
}
