export type TaskStatus =
  | "queued"
  | "awaiting_plan_approval"
  | "generating_patch"
  | "awaiting_approval"
  | "applying_patch"
  | "running_tests"
  | "ready_to_commit"
  | "committed"
  | "failed"
  | "cancelled";

export interface RepoConfig {
  id: string;
  path: string;
  defaultBaseBranch: string;
  testProfiles: Record<string, string[]>;
}

export interface CodexPatchResult {
  summary: string;
  patch: string;
  test_commands: string[];
  risk_notes: string[];
}

export interface TaskRecord {
  taskId: string;
  repoId: string;
  requesterDiscordUserId: string;
  requesterChannelId: string;
  status: TaskStatus;
  prompt: string;
  baseBranch: string;
  testProfile: string | null;
  branchName: string;
  summary: string | null;
  patch: string | null;
  testCommands: string[];
  riskNotes: string[];
  firstChangedFile: string | null;
  committedHash: string | null;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface TaskCreateInput {
  repoId: string;
  requesterDiscordUserId: string;
  requesterChannelId: string;
  prompt: string;
  baseBranch: string;
  testProfile: string | null;
  branchName: string;
}

export interface PatchValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  changedFiles: string[];
  firstChangedFile: string | null;
  addedLines: number;
  deletedLines: number;
}

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TaskUpdateEvent {
  taskId: string;
  channelId: string;
  level: "stream" | "milestone" | "plan" | "approval" | "error" | "danger_confirm";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface PendingConfirmation {
  token: string;
  taskId: string;
  userId: string;
  channelId: string;
  actionType: "danger_command" | "nl_command";
  payload: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
}

export type MemorySource = "manual" | "gemini" | "evolution";

export interface MemoryRecord {
  id: number;
  userId: string;
  channelId: string;
  content: string;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
}

export interface UserContextMessage {
  id: number;
  userId: string;
  channelId: string;
  content: string;
  createdAt: string;
}
