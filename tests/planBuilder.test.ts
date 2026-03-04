import { buildExecutionPlan } from "../src/orchestrator/planBuilder";

describe("buildExecutionPlan", () => {
  it("builds a readable plan with required steps", () => {
    const plan = buildExecutionPlan({
      repoId: "sample",
      baseBranch: "main",
      branchName: "bot/task-abc",
      prompt: "在 docs/a.txt 写一句话",
      testProfile: null,
      openVsCode: false
    });

    expect(plan.summary).toContain("目标");
    expect(plan.steps.length).toBeGreaterThanOrEqual(5);
    expect(plan.steps.join(" ")).toContain("sample");
    expect(plan.steps.join(" ")).toContain("main");
  });

  it("adds VS Code note when enabled", () => {
    const plan = buildExecutionPlan({
      repoId: "sample",
      baseBranch: "main",
      branchName: "bot/task-abc",
      prompt: "修复登录",
      testProfile: "quick",
      openVsCode: true
    });

    expect(plan.notes.join(" ")).toContain("VS Code");
    expect(plan.steps.join(" ")).toContain("quick");
  });
});
