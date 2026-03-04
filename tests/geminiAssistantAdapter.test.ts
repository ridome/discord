import { getGeminiModelCandidates, normalizeGeminiDecision } from "../src/adapters/geminiAssistantAdapter";

describe("normalizeGeminiDecision", () => {
  it("maps task command with boolean args", () => {
    const result = normalizeGeminiDecision({
      mode: "command",
      slashCommand: "task",
      args: {
        repo: "sample",
        prompt: "修复登录",
        open_vscode: "true"
      }
    });

    expect(result.command).not.toBeNull();
    expect(result.command?.slashCommand).toBe("task");
    expect(result.command?.args.repo).toBe("sample");
    expect(result.command?.args.prompt).toBe("修复登录");
    expect(result.command?.args.open_vscode).toBe(true);
    expect(result.reply).toBeNull();
    expect(result.memoryToSave).toBeNull();
  });

  it("returns reply mode text", () => {
    const result = normalizeGeminiDecision({
      mode: "reply",
      reply: "你好，我可以帮你创建任务。"
    });

    expect(result.command).toBeNull();
    expect(result.reply).toContain("你好");
    expect(result.memoryToSave).toBeNull();
  });

  it("drops invalid command payload", () => {
    const result = normalizeGeminiDecision({
      mode: "command",
      slashCommand: "run",
      args: {
        task_id: "task-1"
      }
    });

    expect(result.command).toBeNull();
    expect(result.reply).toBeNull();
    expect(result.memoryToSave).toBeNull();
  });

  it("maps read command payload", () => {
    const result = normalizeGeminiDecision({
      mode: "command",
      slashCommand: "read",
      args: {
        path: "D:\\work\\sample-repo\\README.md",
        repo: "sample",
        start_line: "1",
        end_line: "50"
      }
    });

    expect(result.command).not.toBeNull();
    expect(result.command?.slashCommand).toBe("read");
    expect(result.command?.args.path).toBe("D:\\work\\sample-repo\\README.md");
    expect(result.command?.args.repo).toBe("sample");
  });

  it("extracts memory candidate when remember=true", () => {
    const result = normalizeGeminiDecision({
      mode: "reply",
      reply: "收到。",
      memory: {
        remember: true,
        content: "用户偏好使用中文交流"
      }
    });

    expect(result.memoryToSave).toBe("用户偏好使用中文交流");
  });

  it("builds fallback model list with dedup", () => {
    const models = getGeminiModelCandidates("gemini-3.0-flash");
    expect(models[0]).toBe("gemini-3.0-flash");
    expect(models).toContain("gemini-2.0-flash");
    expect(models).toContain("gemini-1.5-flash");
  });
});
