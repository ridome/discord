import { Logger } from "../logger";
import { CodexPatchResult } from "../types";
import { PatchGenerateInput, PatchGenerator } from "./patchGenerator";

export class FallbackPatchGenerator implements PatchGenerator {
  public readonly providerId = "auto";
  public readonly displayName: string;

  constructor(
    private readonly primary: PatchGenerator,
    private readonly fallback: PatchGenerator,
    private readonly logger: Logger
  ) {
    this.displayName = `${primary.displayName} -> ${fallback.displayName}`;
  }

  public async generatePatch(input: PatchGenerateInput): Promise<CodexPatchResult> {
    input.onStream?.(`[patch-provider] primary=${this.primary.providerId}`);
    try {
      return await this.primary.generatePatch(input);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(
        `[patch-provider] primary=${this.primary.providerId} failed, fallback=${this.fallback.providerId}: ${message}`
      );
      input.onStream?.(`[patch-provider] ${this.primary.providerId} failed: ${message}`);
      input.onStream?.(`[patch-provider] fallback=${this.fallback.providerId}`);
      return this.fallback.generatePatch(input);
    }
  }
}
