import { CodexPatchResult } from "../types";

export interface PatchGenerateInput {
  repoPath: string;
  userPrompt: string;
  timeoutMs: number;
  onStream?: (message: string) => void;
}

export interface PatchGenerator {
  readonly providerId: string;
  readonly displayName: string;
  generatePatch(input: PatchGenerateInput): Promise<CodexPatchResult>;
}
