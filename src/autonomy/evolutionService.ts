import crypto from "crypto";
import { GeminiAssistantAdapter } from "../adapters/geminiAssistantAdapter";
import { Logger } from "../logger";
import { StateStore } from "../store/stateStore";

export interface EvolutionServiceOptions {
  enabled: boolean;
  failureContextLimit: number;
  memoryLimit: number;
  systemUserId: string;
  systemChannelId: string;
}

export class EvolutionService {
  private lastFingerprint = "";

  constructor(
    private readonly stateStore: StateStore,
    private readonly geminiAdapter: GeminiAssistantAdapter | null,
    private readonly logger: Logger,
    private readonly options: EvolutionServiceOptions
  ) {}

  public async runOnce(): Promise<void> {
    if (!this.options.enabled) {
      return;
    }
    if (!this.geminiAdapter) {
      return;
    }

    const failures = this.stateStore.listRecentTaskFailures(this.options.failureContextLimit);
    if (failures.length === 0) {
      return;
    }

    const signature = failures.map((f) => `${f.taskId}:${f.lastError}`).join("|");
    const fingerprint = crypto.createHash("sha1").update(signature).digest("hex");
    if (fingerprint === this.lastFingerprint) {
      return;
    }

    const failureLines = failures.map(
      (f) => `[${f.taskId}] repo=${f.repoId} prompt=${f.prompt} error=${f.lastError}`
    );
    const existingMemories = this.stateStore
      .listMemories(this.options.systemUserId, this.options.memoryLimit)
      .map((m) => m.content);

    const candidates = await this.geminiAdapter.suggestEvolutionMemories(failureLines, existingMemories);
    if (candidates.length === 0) {
      this.lastFingerprint = fingerprint;
      return;
    }

    let created = 0;
    for (const item of candidates) {
      const saved = this.stateStore.upsertMemory(
        this.options.systemUserId,
        this.options.systemChannelId,
        item,
        "evolution"
      );
      if (saved.created) {
        created += 1;
      }
    }

    this.lastFingerprint = fingerprint;
    this.logger.info(`[evolution] candidates=${candidates.length}, created=${created}`);
  }
}
