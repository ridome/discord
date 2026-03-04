import { FallbackPatchGenerator } from "../src/adapters/fallbackPatchGenerator";
import { PatchGenerateInput, PatchGenerator } from "../src/adapters/patchGenerator";
import { Logger } from "../src/logger";

const samplePatch = {
  summary: "ok",
  patch: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
  test_commands: [],
  risk_notes: []
};

class StubGenerator implements PatchGenerator {
  constructor(
    public readonly providerId: string,
    public readonly displayName: string,
    private readonly mode: "ok" | "fail"
  ) {}

  public async generatePatch(_input: PatchGenerateInput) {
    if (this.mode === "fail") {
      throw new Error(`${this.providerId} failed`);
    }
    return samplePatch;
  }
}

describe("FallbackPatchGenerator", () => {
  it("returns primary result when primary succeeds", async () => {
    const logger = new Logger();
    const primary = new StubGenerator("codex", "Codex", "ok");
    const secondary = new StubGenerator("gemini", "Gemini", "ok");
    const adapter = new FallbackPatchGenerator(primary, secondary, logger);

    const result = await adapter.generatePatch({
      repoPath: ".",
      userPrompt: "test",
      timeoutMs: 1000
    });

    expect(result.summary).toBe("ok");
  });

  it("falls back when primary fails", async () => {
    const logger = new Logger();
    const primary = new StubGenerator("codex", "Codex", "fail");
    const secondary = new StubGenerator("gemini", "Gemini", "ok");
    const adapter = new FallbackPatchGenerator(primary, secondary, logger);

    const stream: string[] = [];
    const result = await adapter.generatePatch({
      repoPath: ".",
      userPrompt: "test",
      timeoutMs: 1000,
      onStream: (line) => stream.push(line)
    });

    expect(result.summary).toBe("ok");
    expect(stream.join("\n")).toContain("fallback=gemini");
  });
});
