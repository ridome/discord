import { buildContextualFallbackReply, tryLocalIntentReply } from "../src/discord/localReplyRules";

describe("localReplyRules", () => {
  it("answers folder/path question with concrete example", () => {
    const reply = tryLocalIntentReply("我可以指定文件夹吗？", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("可以指定");
    expect(reply).toContain("repo=sample");
  });

  it("explains local repo path usage", () => {
    const reply = tryLocalIntentReply("我要仓库外 D:\\work\\test", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("本地路径");
    expect(reply).toContain("Git 仓库");
  });

  it("answers capability question", () => {
    const reply = tryLocalIntentReply("你的工作是什么？", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("聊天");
    expect(reply).toContain("创建任务");
  });

  it("answers story request in local fallback", () => {
    const reply = tryLocalIntentReply("你好，给我讲个故事", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("讲一个短的");
  });

  it("degrades to generic fallback when gemini fails", () => {
    const reply = buildContextualFallbackReply(
      "随便聊聊",
      "sample",
      "Gemini API error: HTTP 404 model not supported"
    );
    expect(reply).toContain("本地规则");
  });

  it("answers restart question without model dependency", () => {
    const reply = tryLocalIntentReply("可以重新跑起来吗", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("restart-bot.bat");
  });

  it("answers local file read hint", () => {
    const reply = tryLocalIntentReply("读取 D:\\work\\sample-repo\\README.md", "sample");
    expect(reply).not.toBeNull();
    expect(reply).toContain("/read");
  });
});
