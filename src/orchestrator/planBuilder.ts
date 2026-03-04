export interface PlanBuildInput {
  repoId: string;
  baseBranch: string;
  branchName: string;
  prompt: string;
  testProfile: string | null;
  openVsCode: boolean;
}

export interface ExecutionPlan {
  summary: string;
  steps: string[];
  notes: string[];
}

function firstLine(text: string, maxLen = 140): string {
  const line = text.split(/\r?\n/)[0].trim();
  if (!line) {
    return "（未提供目标）";
  }
  return line.length > maxLen ? `${line.slice(0, maxLen)}...` : line;
}

export function buildExecutionPlan(input: PlanBuildInput): ExecutionPlan {
  const summary = `目标：${firstLine(input.prompt)}`;
  const testHint = input.testProfile
    ? `使用测试配置 \`${input.testProfile}\``
    : "使用仓库默认测试策略（若无则使用 Codex 建议）";

  const notes: string[] = [
    "补丁生成与校验在本地执行，Codex 不会直接改你的文件。",
    "测试失败时不会自动提交，改动会保留供你继续处理。",
    "默认只提交到任务分支，不会自动 push。"
  ];
  if (input.openVsCode) {
    notes.push("执行时会自动打开 VS Code 并定位变更文件。");
  }

  return {
    summary,
    steps: [
      `在仓库 \`${input.repoId}\` 基于 \`${input.baseBranch}\` 准备任务分支 \`${input.branchName}\`。`,
      "调用 Codex 生成结构化补丁（Diff 优先，只读沙盒）。",
      "执行补丁安全校验并发送补丁审批卡片。",
      `你批准补丁后应用改动并执行测试（${testHint}）。`,
      "测试通过后自动提交到任务分支。"
    ],
    notes
  };
}
