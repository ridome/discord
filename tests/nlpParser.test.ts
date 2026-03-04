import {
  parseNaturalLanguageBody,
  parseNaturalLanguageCommand,
  parseNaturalLanguageFreeText
} from "../src/nlp/parseNaturalLanguage";

describe("parseNaturalLanguageCommand", () => {
  const prefix = "!codex";
  const botId = "123";

  it("parses task command", () => {
    const parsed = parseNaturalLanguageCommand(
      '!codex task repo=sample prompt="fix login bug" test_profile=quick open_vscode=true',
      prefix,
      botId
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.slashCommand).toBe("task");
    expect(parsed?.args.repo).toBe("sample");
    expect(parsed?.args.prompt).toBe("fix login bug");
    expect(parsed?.args.test_profile).toBe("quick");
    expect(parsed?.args.open_vscode).toBe(true);
  });

  it("parses run command", () => {
    const parsed = parseNaturalLanguageCommand(
      '!codex run task_id=task-1 cmd="git status"',
      prefix,
      botId
    );
    expect(parsed?.slashCommand).toBe("run");
    expect(parsed?.args.task_id).toBe("task-1");
    expect(parsed?.args.cmd).toBe("git status");
  });

  it("parses read command with Windows path", () => {
    const parsed = parseNaturalLanguageCommand(
      "!codex 读取 path=D:\\work\\sample-repo\\README.md",
      prefix,
      botId
    );
    expect(parsed?.slashCommand).toBe("read");
    expect(parsed?.args.path).toBe("D:\\work\\sample-repo\\README.md");
  });

  it("returns null when no trigger", () => {
    const parsed = parseNaturalLanguageCommand("hello", prefix, botId);
    expect(parsed).toBeNull();
  });

  it("parses Chinese task alias", () => {
    const parsed = parseNaturalLanguageCommand(
      '!codex 创建任务 repo=sample prompt="修复登录重定向"',
      prefix,
      botId
    );
    expect(parsed?.slashCommand).toBe("task");
    expect(parsed?.args.repo).toBe("sample");
    expect(parsed?.args.prompt).toBe("修复登录重定向");
  });

  it("parses Chinese status alias", () => {
    const parsed = parseNaturalLanguageCommand("!codex 状态 task_id=task-1", prefix, botId);
    expect(parsed?.slashCommand).toBe("status");
    expect(parsed?.args.task_id).toBe("task-1");
  });

  it("parses voice-transcribed body without trigger", () => {
    const parsed = parseNaturalLanguageBody("创建任务 repo=sample prompt=修复登录");
    expect(parsed?.slashCommand).toBe("task");
    expect(parsed?.args.repo).toBe("sample");
  });

  it("parses ping alias", () => {
    const parsed = parseNaturalLanguageBody("健康检查");
    expect(parsed?.slashCommand).toBe("ping");
  });

  it("parses free Chinese sentence to task with default repo", () => {
    const parsed = parseNaturalLanguageFreeText(
      "我想创建一个文件夹，里面帮我写一个笑话",
      { defaultRepoId: "sample" }
    );
    expect(parsed?.slashCommand).toBe("task");
    expect(parsed?.args.repo).toBe("sample");
  });

  it("parses free Chinese sentence to status", () => {
    const parsed = parseNaturalLanguageFreeText("帮我看一下 task-abc123 的状态");
    expect(parsed?.slashCommand).toBe("status");
    expect(parsed?.args.task_id).toBe("task-abc123");
  });

  it("parses free Chinese sentence to read command", () => {
    const parsed = parseNaturalLanguageFreeText(
      "读取这个文件把结果给我。Markdown:D:\\work\\sample-repo\\new\\a_share_20_30yi.md"
    );
    expect(parsed?.slashCommand).toBe("read");
    expect(parsed?.args.path).toBe("D:\\work\\sample-repo\\new\\a_share_20_30yi.md");
  });

  it("does not force chat request into task command", () => {
    const parsed = parseNaturalLanguageFreeText("给我讲个故事", { defaultRepoId: "sample" });
    expect(parsed).toBeNull();
  });

  it("does not auto-create task when implicit task parsing is disabled", () => {
    const parsed = parseNaturalLanguageFreeText(
      "帮我修复登录并补测试",
      { defaultRepoId: "sample", allowImplicitTaskIntent: false }
    );
    expect(parsed).toBeNull();
  });
});
