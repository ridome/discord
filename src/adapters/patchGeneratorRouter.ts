import { Logger } from "../logger";
import { CodexPatchResult } from "../types";
import { PatchGenerateInput, PatchGenerator } from "./patchGenerator";

export type PatchProviderName = "codex" | "gemini" | "auto";

export interface PatchProviderState {
  active: PatchProviderName;
  available: PatchProviderName[];
  displayName: string;
}

const PROVIDER_ORDER: PatchProviderName[] = ["auto", "codex", "gemini"];

export class PatchGeneratorRouter implements PatchGenerator {
  private readonly providerMap: Partial<Record<PatchProviderName, PatchGenerator>>;
  private activeProvider: PatchProviderName;

  constructor(
    providers: Partial<Record<PatchProviderName, PatchGenerator>>,
    defaultProvider: PatchProviderName,
    private readonly logger: Logger
  ) {
    this.providerMap = providers;
    this.activeProvider = this.resolveInitialProvider(defaultProvider);
  }

  public get providerId(): string {
    return this.activeProvider;
  }

  public get displayName(): string {
    return this.getActiveGenerator().displayName;
  }

  public getState(): PatchProviderState {
    return {
      active: this.activeProvider,
      available: this.listAvailableProviders(),
      displayName: this.displayName
    };
  }

  public setActiveProvider(provider: PatchProviderName): PatchProviderState {
    if (!this.providerMap[provider]) {
      throw new Error(
        `Patch provider not available: ${provider}. Available: ${this.listAvailableProviders().join(", ")}`
      );
    }
    this.activeProvider = provider;
    this.logger.info(`[patch-provider] switched to ${provider} (${this.displayName})`);
    return this.getState();
  }

  public async generatePatch(input: PatchGenerateInput): Promise<CodexPatchResult> {
    const active = this.activeProvider;
    input.onStream?.(`[patch-provider] active=${active}`);
    return this.getActiveGenerator().generatePatch(input);
  }

  private listAvailableProviders(): PatchProviderName[] {
    return PROVIDER_ORDER.filter((name) => Boolean(this.providerMap[name]));
  }

  private resolveInitialProvider(defaultProvider: PatchProviderName): PatchProviderName {
    if (this.providerMap[defaultProvider]) {
      return defaultProvider;
    }
    const fallback = this.listAvailableProviders()[0];
    if (!fallback) {
      throw new Error("No patch provider available.");
    }
    this.logger.warn(
      `[patch-provider] default ${defaultProvider} unavailable, fallback to ${fallback}`
    );
    return fallback;
  }

  private getActiveGenerator(): PatchGenerator {
    const active = this.providerMap[this.activeProvider];
    if (!active) {
      throw new Error(
        `Patch provider unavailable at runtime: ${this.activeProvider}. Available: ${this.listAvailableProviders().join(", ")}`
      );
    }
    return active;
  }
}
