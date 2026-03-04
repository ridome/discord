import { Logger } from "../src/logger";
import { CodexPatchResult } from "../src/types";
import { PatchGenerateInput, PatchGenerator } from "../src/adapters/patchGenerator";
import { PatchGeneratorRouter } from "../src/adapters/patchGeneratorRouter";

class StubGenerator implements PatchGenerator {
  constructor(
    public readonly providerId: string,
    public readonly displayName: string,
    private readonly summary: string
  ) {}

  public async generatePatch(_input: PatchGenerateInput): Promise<CodexPatchResult> {
    return {
      summary: this.summary,
      patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      test_commands: [],
      risk_notes: []
    };
  }
}

describe("PatchGeneratorRouter", () => {
  it("falls back to available provider when default is unavailable", () => {
    const logger = new Logger();
    const codex = new StubGenerator("codex", "Codex", "from-codex");
    const router = new PatchGeneratorRouter(
      {
        codex,
        auto: codex
      },
      "gemini",
      logger
    );

    expect(router.getState().active).toBe("auto");
  });

  it("switches provider at runtime", () => {
    const logger = new Logger();
    const codex = new StubGenerator("codex", "Codex", "from-codex");
    const gemini = new StubGenerator("gemini", "Gemini", "from-gemini");
    const router = new PatchGeneratorRouter(
      {
        codex,
        gemini,
        auto: codex
      },
      "codex",
      logger
    );

    const state = router.setActiveProvider("gemini");
    expect(state.active).toBe("gemini");
    expect(state.displayName).toBe("Gemini");
  });

  it("routes generatePatch to active provider", async () => {
    const logger = new Logger();
    const codex = new StubGenerator("codex", "Codex", "from-codex");
    const gemini = new StubGenerator("gemini", "Gemini", "from-gemini");
    const router = new PatchGeneratorRouter(
      {
        codex,
        gemini,
        auto: codex
      },
      "codex",
      logger
    );

    router.setActiveProvider("gemini");
    const result = await router.generatePatch({
      repoPath: ".",
      userPrompt: "test",
      timeoutMs: 1000
    });

    expect(result.summary).toBe("from-gemini");
  });
});
