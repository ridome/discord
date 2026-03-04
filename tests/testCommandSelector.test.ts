import { sanitizeSuggestedTestCommands, selectTestCommands } from "../src/orchestrator/testCommandSelector";

describe("testCommandSelector", () => {
  it("rejects placeholder and patch-apply commands from codex suggestions", () => {
    const result = sanitizeSuggestedTestCommands([
      "git apply --check <patch-file>",
      "git apply <patch-file>",
      "npm test",
      "pnpm -r test"
    ]);

    expect(result.accepted).toEqual(["npm test", "pnpm -r test"]);
    expect(result.rejected).toEqual(["git apply --check <patch-file>", "git apply <patch-file>"]);
  });

  it("falls back to default profile when codex suggestions are all rejected", () => {
    const selected = selectTestCommands(
      null,
      { default: ["npm test"] },
      ["git apply --check <patch-file>"]
    );

    expect(selected.commands).toEqual(["npm test"]);
    expect(selected.source).toBe("default");
    expect(selected.droppedSuggested).toEqual(["git apply --check <patch-file>"]);
  });

  it("uses explicit test profile over codex suggestions", () => {
    const selected = selectTestCommands(
      "quick",
      { default: ["npm test"], quick: ["npm run test:quick"] },
      ["echo should-not-use"]
    );

    expect(selected.commands).toEqual(["npm run test:quick"]);
    expect(selected.source).toBe("profile");
    expect(selected.droppedSuggested).toEqual([]);
  });
});
