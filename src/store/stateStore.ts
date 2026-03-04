import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  MemoryRecord,
  MemorySource,
  PendingConfirmation,
  TaskCreateInput,
  TaskRecord,
  TaskStatus,
  UserContextMessage
} from "../types";
import { nowIso } from "../utils/time";

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTask(row: any): TaskRecord {
  return {
    taskId: row.task_id,
    repoId: row.repo_id,
    requesterDiscordUserId: row.requester_user_id,
    requesterChannelId: row.requester_channel_id,
    status: row.status,
    prompt: row.prompt,
    baseBranch: row.base_branch,
    testProfile: row.test_profile,
    branchName: row.branch_name,
    summary: row.summary,
    patch: row.patch,
    testCommands: parseJsonArray(row.test_commands_json),
    riskNotes: parseJsonArray(row.risk_notes_json),
    firstChangedFile: row.first_changed_file,
    committedHash: row.committed_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error
  };
}

function mapMemory(row: any): MemoryRecord {
  return {
    id: Number(row.id),
    userId: row.user_id,
    channelId: row.channel_id,
    content: row.content,
    source: row.source as MemorySource,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUserContextMessage(row: any): UserContextMessage {
  return {
    id: Number(row.id),
    userId: row.user_id,
    channelId: row.channel_id,
    content: row.content,
    createdAt: row.created_at
  };
}

function normalizeMemoryContent(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const fullPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    this.db = new Database(fullPath);
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        requester_user_id TEXT NOT NULL,
        requester_channel_id TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        test_profile TEXT,
        branch_name TEXT NOT NULL,
        summary TEXT,
        patch TEXT,
        test_commands_json TEXT,
        risk_notes_json TEXT,
        first_changed_file TEXT,
        committed_hash TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        approver_user_id TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_confirmations (
        token TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        content_norm TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_user_content_norm
      ON memories(user_id, content_norm);

      CREATE INDEX IF NOT EXISTS idx_memories_user_updated
      ON memories(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS user_memory_settings (
        user_id TEXT PRIMARY KEY,
        auto_from_gemini INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_context_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_user_context_user_channel_created
      ON user_context_messages(user_id, channel_id, created_at DESC);
    `);
  }

  public createTask(taskId: string, input: TaskCreateInput): TaskRecord {
    const now = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        task_id, repo_id, requester_user_id, requester_channel_id, status,
        prompt, base_branch, test_profile, branch_name, summary, patch,
        test_commands_json, risk_notes_json, first_changed_file, committed_hash,
        last_error, created_at, updated_at
      ) VALUES (
        @task_id, @repo_id, @requester_user_id, @requester_channel_id, @status,
        @prompt, @base_branch, @test_profile, @branch_name, @summary, @patch,
        @test_commands_json, @risk_notes_json, @first_changed_file, @committed_hash,
        @last_error, @created_at, @updated_at
      )
    `);

    stmt.run({
      task_id: taskId,
      repo_id: input.repoId,
      requester_user_id: input.requesterDiscordUserId,
      requester_channel_id: input.requesterChannelId,
      status: "queued",
      prompt: input.prompt,
      base_branch: input.baseBranch,
      test_profile: input.testProfile,
      branch_name: input.branchName,
      summary: null,
      patch: null,
      test_commands_json: "[]",
      risk_notes_json: "[]",
      first_changed_file: null,
      committed_hash: null,
      last_error: null,
      created_at: now,
      updated_at: now
    });

    return this.getTaskOrThrow(taskId);
  }

  public updateTaskStatus(taskId: string, status: TaskStatus, lastError: string | null = null): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, last_error = ?, updated_at = ? WHERE task_id = ?`
      )
      .run(status, lastError, nowIso(), taskId);
  }

  public updatePatchResult(
    taskId: string,
    summary: string,
    patch: string,
    testCommands: string[],
    riskNotes: string[],
    firstChangedFile: string | null
  ): void {
    this.db
      .prepare(
        `
        UPDATE tasks
        SET summary = ?,
            patch = ?,
            test_commands_json = ?,
            risk_notes_json = ?,
            first_changed_file = ?,
            updated_at = ?
        WHERE task_id = ?
      `
      )
      .run(
        summary,
        patch,
        JSON.stringify(testCommands),
        JSON.stringify(riskNotes),
        firstChangedFile,
        nowIso(),
        taskId
      );
  }

  public setCommitted(taskId: string, hash: string): void {
    this.db
      .prepare(`UPDATE tasks SET committed_hash = ?, updated_at = ? WHERE task_id = ?`)
      .run(hash, nowIso(), taskId);
  }

  public getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(taskId);
    return row ? mapTask(row) : null;
  }

  public getTaskOrThrow(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  public addTaskEvent(taskId: string, level: string, message: string): void {
    this.db
      .prepare(
        `INSERT INTO task_events (task_id, level, message, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(taskId, level, message, nowIso());
  }

  public getRecentTaskEvents(taskId: string, limit = 20): Array<{ level: string; message: string; createdAt: string }> {
    const rows = this.db
      .prepare(
        `
        SELECT level, message, created_at
        FROM task_events
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT ?
      `
      )
      .all(taskId, limit);

    return rows.map((row: any) => ({
      level: row.level,
      message: row.message,
      createdAt: row.created_at
    }));
  }

  public addApproval(
    taskId: string,
    action: string,
    approverUserId: string,
    payload: Record<string, unknown>
  ): void {
    this.db
      .prepare(
        `INSERT INTO approvals (task_id, action, approver_user_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, action, approverUserId, JSON.stringify(payload), nowIso());
  }

  public savePendingConfirmation(input: PendingConfirmation): void {
    this.db
      .prepare(
        `
        INSERT INTO pending_confirmations (
          token, task_id, user_id, channel_id, action_type, payload_json, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.token,
        input.taskId,
        input.userId,
        input.channelId,
        input.actionType,
        JSON.stringify(input.payload),
        input.expiresAt,
        input.createdAt
      );
  }

  public getPendingConfirmation(token: string): PendingConfirmation | null {
    const row = this.db
      .prepare(`SELECT * FROM pending_confirmations WHERE token = ?`)
      .get(token) as any;

    if (!row) {
      return null;
    }

    return {
      token: row.token,
      taskId: row.task_id,
      userId: row.user_id,
      channelId: row.channel_id,
      actionType: row.action_type,
      payload: JSON.parse(row.payload_json),
      expiresAt: row.expires_at,
      createdAt: row.created_at
    };
  }

  public deletePendingConfirmation(token: string): void {
    this.db.prepare(`DELETE FROM pending_confirmations WHERE token = ?`).run(token);
  }

  public cleanupExpiredConfirmations(): void {
    this.db
      .prepare(`DELETE FROM pending_confirmations WHERE expires_at < ?`)
      .run(nowIso());
  }

  public cleanupOldEvents(retentionDays: number): void {
    const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString();
    this.db.prepare(`DELETE FROM task_events WHERE created_at < ?`).run(cutoff);
  }

  public addUserContextMessage(userId: string, channelId: string, content: string): void {
    const normalized = content.trim().replace(/\s+/g, " ");
    if (!normalized) {
      return;
    }

    this.db
      .prepare(
        `INSERT INTO user_context_messages (user_id, channel_id, content, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(userId, channelId, normalized.slice(0, 2000), nowIso());
  }

  public listRecentUserContext(userId: string, channelId: string, limit = 12): UserContextMessage[] {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 12));
    const rows = this.db
      .prepare(
        `SELECT id, user_id, channel_id, content, created_at
         FROM user_context_messages
         WHERE user_id = ? AND channel_id = ?
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(userId, channelId, safeLimit);

    return rows.map((row: any) => mapUserContextMessage(row)).reverse();
  }

  public cleanupOldUserContext(retentionDays: number): void {
    const safeDays = Math.max(0, Number(retentionDays) || 0);
    const cutoff = new Date(Date.now() - safeDays * 86400 * 1000).toISOString();
    this.db.prepare(`DELETE FROM user_context_messages WHERE created_at <= ?`).run(cutoff);
  }

  public upsertMemory(
    userId: string,
    channelId: string,
    content: string,
    source: MemorySource
  ): { record: MemoryRecord; created: boolean } {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("Memory content cannot be empty.");
    }

    const normalized = normalizeMemoryContent(trimmed);
    const now = nowIso();
    const existing = this.db
      .prepare(`SELECT id FROM memories WHERE user_id = ? AND content_norm = ?`)
      .get(userId, normalized) as any;

    if (existing) {
      this.db
        .prepare(
          `UPDATE memories
           SET channel_id = ?, source = ?, content = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(channelId, source, trimmed, now, existing.id);
      const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(existing.id) as any;
      return { record: mapMemory(row), created: false };
    }

    const result = this.db
      .prepare(
        `INSERT INTO memories (user_id, channel_id, content, content_norm, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(userId, channelId, trimmed, normalized, source, now, now);

    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(result.lastInsertRowid) as any;
    return { record: mapMemory(row), created: true };
  }

  public listMemories(userId: string, limit = 20): MemoryRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, safeLimit);
    return rows.map((row: any) => mapMemory(row));
  }

  public deleteMemory(userId: string, memoryId: number): boolean {
    const result = this.db
      .prepare(`DELETE FROM memories WHERE id = ? AND user_id = ?`)
      .run(memoryId, userId);
    return result.changes > 0;
  }

  public clearMemories(userId: string): number {
    const result = this.db.prepare(`DELETE FROM memories WHERE user_id = ?`).run(userId);
    return result.changes;
  }

  public setAutoMemoryEnabled(userId: string, enabled: boolean): void {
    const now = nowIso();
    const value = enabled ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO user_memory_settings (user_id, auto_from_gemini, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           auto_from_gemini=excluded.auto_from_gemini,
           updated_at=excluded.updated_at`
      )
      .run(userId, value, now);
  }

  public isAutoMemoryEnabled(userId: string): boolean {
    const row = this.db
      .prepare(`SELECT auto_from_gemini FROM user_memory_settings WHERE user_id = ?`)
      .get(userId) as any;
    if (!row) {
      return true;
    }
    return Number(row.auto_from_gemini) === 1;
  }

  public listRecentTaskFailures(limit = 20): Array<{
    taskId: string;
    repoId: string;
    prompt: string;
    lastError: string;
    updatedAt: string;
  }> {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = this.db
      .prepare(
        `
        SELECT task_id, repo_id, prompt, last_error, updated_at
        FROM tasks
        WHERE status = 'failed' AND last_error IS NOT NULL AND length(trim(last_error)) > 0
        ORDER BY updated_at DESC
        LIMIT ?
      `
      )
      .all(safeLimit);

    return rows.map((row: any) => ({
      taskId: row.task_id,
      repoId: row.repo_id,
      prompt: row.prompt,
      lastError: row.last_error,
      updatedAt: row.updated_at
    }));
  }
}
