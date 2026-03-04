export function buildContextualFallbackReply(
  userInput: string,
  defaultRepoId: string | null,
  geminiErrorMessage?: string | null
): string {
  const text = userInput.trim();
  const repo = defaultRepoId ?? "<repo_id>";

  if (/(重新跑起来|重新启动|重启|restart|再启动一下)/i.test(text)) {
    return "可以。你可以直接双击 `restart-bot.bat` 重启机器人，随后用 `/ping` 确认在线状态。";
  }

  if (geminiErrorMessage) {
    return "收到。你可以继续直接说目标，我会先按本地规则理解并给你可执行确认。";
  }

  if (/(读取|读文件|查看文件|read file|cat)/i.test(text) && /[a-zA-Z]:\\/.test(text)) {
    return "可以直接读本地文件。示例：`/read path:D:\\work\\sample-repo\\README.md`";
  }

  if (
    /(仓库外|仓库路径|仓库地址|repo参数|repo 参数|绝对路径|本地路径|目录路径)/i.test(text) ||
    /[a-zA-Z]:\\[^ ]+/.test(text)
  ) {
    return (
      "支持本地路径作为 `repo`，但该路径必须是本机可访问的 Git 仓库。\n" +
      "你也可以继续使用白名单仓库 ID。示例：`/task repo=D:\\work\\test prompt=分析这个目录下的代码`"
    );
  }

  if (/(讲个?故事|故事|笑话|段子|闲聊|聊聊)/i.test(text)) {
    return (
      "当然可以。程序员说“马上修好”，结果先修了三杯咖啡。你要不要我再来一个更短的？\n" +
      `如果你想落地到仓库，也可以：\`!codex 创建任务 repo=${repo} prompt=\"在 docs/joke.txt 写一个中文笑话\"\``
    );
  }

  if (/^(你好|嗨|hi|hello)/i.test(text)) {
    return "在。你可以直接说需求，我能聊天，也能把可执行操作转成待确认命令。";
  }

  if (/(文件夹|目录|路径|path)/i.test(text) && /(指定|放到|写到|存到|在哪|位置|可以|能不能)/i.test(text)) {
    return (
      "可以。你可以在 `prompt` 里写目标路径（相对仓库根目录）。\n" +
      `示例：\`!codex 创建任务 repo=${repo} prompt=\"在 docs/jokes/joke1.txt 写一个笑话\"\``
    );
  }

  if (/(你能做什么|你会什么|你的工作|怎么用|帮助|help)/i.test(text)) {
    return (
      "我可以聊天，也可以创建任务、查状态、审批、执行命令。\n" +
      `示例：\`!codex 创建任务 repo=${repo} prompt=\"修复登录并补测试\"\`，我会先让你确认。`
    );
  }

  return "收到。你可以直接自然中文说需求，我会先理解，再给你可确认的执行动作。";
}

export function tryLocalIntentReply(userInput: string, defaultRepoId: string | null): string | null {
  const text = userInput.trim();
  const repo = defaultRepoId ?? "<repo_id>";

  if (/(重新跑起来|重新启动|重启|restart|再启动一下)/i.test(text)) {
    return "可以。直接双击 `restart-bot.bat`，然后用 `/ping` 看是否在线。";
  }

  if (/(读取|读文件|查看文件|read file|cat)/i.test(text) && /[a-zA-Z]:\\/.test(text)) {
    return "可以直接读本地文件：`/read path:D:\\work\\sample-repo\\README.md`";
  }

  if (
    /(仓库外|仓库路径|仓库地址|repo参数|repo 参数|绝对路径|本地路径|目录路径)/i.test(text) ||
    /[a-zA-Z]:\\[^ ]+/.test(text)
  ) {
    return (
      "可以直接用本地路径作为 `repo`，但路径必须是 Git 仓库。\n" +
      "示例：`/task repo=D:\\work\\test prompt=修复登录并补测试`"
    );
  }

  if (/(讲个?故事|故事|笑话|段子|闲聊|聊聊)/i.test(text)) {
    return (
      "讲一个短的：Bug 说“不是我”，测试说“就是你”，程序员说“先重启试试”。\n" +
      `要我把笑话写进仓库文件，也可以：\`!codex 创建任务 repo=${repo} prompt=\"在 docs/joke.txt 写一个笑话\"\``
    );
  }

  if (/^(你好|嗨|hi|hello)/i.test(text)) {
    return "你好，我在。你可以直接说目标，我会尽量先理解你的话再执行。";
  }

  if (/(文件夹|目录|路径|path)/i.test(text) && /(指定|放到|写到|存到|在哪|位置|可以|能不能)/i.test(text)) {
    return (
      "可以指定。但路径应写在 `prompt` 且相对仓库根目录。\n" +
      `示例：\`!codex 创建任务 repo=${repo} prompt=\"在 docs/jokes/joke1.txt 写一个笑话\"\``
    );
  }

  if (/(你能做什么|你会什么|你的工作|怎么用|帮助|help)/i.test(text)) {
    return (
      "我可以：聊天、创建任务、查状态、审批、执行命令。\n" +
      `比如：\`!codex 创建任务 repo=${repo} prompt=\"修复登录并补测试\"\`（会先让你确认）。`
    );
  }

  return null;
}
