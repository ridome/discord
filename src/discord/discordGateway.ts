const Eris = require("eris");
const { HttpsProxyAgent } = require("https-proxy-agent");
import fs from "fs";
import path from "path";
import { AppConfig } from "../config";
import { GeminiAssistantAdapter } from "../adapters/geminiAssistantAdapter";
import { GoogleSpeechAdapter } from "../adapters/googleSpeechAdapter";
import { Logger, redactText } from "../logger";
import {
  parseNaturalLanguageBody,
  parseNaturalLanguageCommand,
  parseNaturalLanguageFreeText
} from "../nlp/parseNaturalLanguage";
import { AccessControl } from "../security/accessControl";
import { TaskOrchestrator } from "../orchestrator/taskOrchestrator";
import { StateStore } from "../store/stateStore";
import { buildContextualFallbackReply, tryLocalIntentReply } from "./localReplyRules";

const SYSTEM_MEMORY_USER_ID = "__system__";
const SYSTEM_MEMORY_CHANNEL_ID = "__system__";

interface CommandOption {
  name: string;
  value: any;
}

interface ParsedNlPayload {
  slashCommand: string;
  args: Record<string, string | boolean>;
  preview: string;
}

function getOption(options: CommandOption[] | undefined, name: string): any {
  if (!options) {
    return undefined;
  }
  return options.find((opt) => opt.name === name)?.value;
}

function isTriggered(content: string, prefix: string, botId: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith(prefix) ||
    trimmed.startsWith(`<@${botId}>`) ||
    trimmed.startsWith(`<@!${botId}>`)
  );
}

function isMentionedMessage(msg: any, botId: string): boolean {
  const mentions = Array.isArray(msg?.mentions) ? msg.mentions : [];
  return mentions.some((m: any) => String(m?.id) === String(botId));
}

function stripTrigger(content: string, prefix: string, botId: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length).trim();
  }
  const mentionPrefix = `<@${botId}>`;
  const mentionNickPrefix = `<@!${botId}>`;
  if (trimmed.startsWith(mentionPrefix)) {
    return trimmed.slice(mentionPrefix.length).trim();
  }
  if (trimmed.startsWith(mentionNickPrefix)) {
    return trimmed.slice(mentionNickPrefix.length).trim();
  }
  return trimmed;
}

function getAttachments(msg: any): any[] {
  if (!msg?.attachments) {
    return [];
  }
  if (Array.isArray(msg.attachments)) {
    return msg.attachments;
  }
  if (typeof msg.attachments === "object") {
    return Object.values(msg.attachments);
  }
  return [];
}

function chunkText(text: string, maxLen = 1800): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }
  return chunks;
}

export class DiscordGateway {
  private readonly bot: any;

  constructor(
    private readonly config: AppConfig,
    private readonly accessControl: AccessControl,
    private readonly orchestrator: TaskOrchestrator,
    private readonly stateStore: StateStore,
    private readonly logger: Logger,
    private readonly speechAdapter: GoogleSpeechAdapter | null = null,
    private readonly geminiAdapter: GeminiAssistantAdapter | null = null
  ) {
    const clientOptions: any = {
      intents:
        Eris.Constants.Intents.guilds |
        Eris.Constants.Intents.guildMessages |
        Eris.Constants.Intents.messageContent
    };

    if (this.config.discordProxyUrl) {
      clientOptions.agent = new HttpsProxyAgent(this.config.discordProxyUrl);
      this.logger.info(`Discord client using proxy: ${this.config.discordProxyUrl}`);
    }

    if (this.speechAdapter) {
      this.logger.info("Google speech adapter enabled.");
    }
    if (this.geminiAdapter) {
      this.logger.info("Gemini assistant adapter enabled.");
    }

    this.bot = new Eris(this.config.discordBotToken, clientOptions);
  }

  public async start(): Promise<void> {
    this.logger.info("Starting Discord gateway...");
    this.orchestrator.onUpdate((event) => {
      void this.handleTaskUpdate(event);
    });

    this.bot.on("connect", () => {
      this.logger.info("Discord websocket connected.");
    });

    this.bot.on("ready", async () => {
      this.logger.info(`Discord bot connected as ${this.bot.user.username}`);
      if (this.config.registerCommands) {
        await this.registerSlashCommands();
      }
    });

    this.bot.on("interactionCreate", (interaction: any) => {
      void this.handleInteraction(interaction);
    });

    this.bot.on("messageCreate", (msg: any) => {
      void this.handleMessage(msg);
    });

    this.bot.on("error", (err: Error) => {
      this.logger.error(`Discord client error: ${err.message}`);
      if (err.message.includes("ETIMEDOUT")) {
        this.logger.warn(
          "Network timeout detected. If your network needs a proxy, set DISCORD_PROXY_URL (e.g. http://127.0.0.1:10809)."
        );
      }
    });

    this.bot.on("disconnect", (err: Error) => {
      if (err) {
        this.logger.warn(`Discord disconnected: ${err.message}`);
      } else {
        this.logger.warn("Discord disconnected.");
      }
    });

    this.bot.on("warn", (msg: string) => {
      this.logger.warn(`Discord warn: ${msg}`);
    });

    this.bot.connect();
  }

  private async registerSlashCommands(): Promise<void> {
    const commands = [
      {
        name: "ping",
        description: "Check bot health and diagnostics"
      },
      {
        name: "provider",
        description: "Show or change patch provider (codex/gemini/auto)",
        options: [
          {
            type: 3,
            name: "mode",
            description: "Target provider",
            required: false,
            choices: [
              { name: "auto", value: "auto" },
              { name: "codex", value: "codex" },
              { name: "gemini", value: "gemini" }
            ]
          }
        ]
      },
      {
        name: "task",
        description: "Create a new codex task",
        options: [
          { type: 3, name: "repo", description: "Repo id", required: true },
          { type: 3, name: "prompt", description: "Task prompt", required: true },
          { type: 3, name: "base_branch", description: "Base branch", required: false },
          { type: 3, name: "test_profile", description: "Test profile", required: false },
          { type: 5, name: "open_vscode", description: "Open VS Code", required: false }
        ]
      },
      {
        name: "status",
        description: "Get task status",
        options: [{ type: 3, name: "task_id", description: "Task ID", required: true }]
      },
      {
        name: "approve",
        description: "Approve plan or task patch",
        options: [{ type: 3, name: "task_id", description: "Task ID", required: true }]
      },
      {
        name: "reject",
        description: "Reject task patch",
        options: [
          { type: 3, name: "task_id", description: "Task ID", required: true },
          { type: 3, name: "reason", description: "Reason", required: false }
        ]
      },
      {
        name: "cancel",
        description: "Cancel task",
        options: [{ type: 3, name: "task_id", description: "Task ID", required: true }]
      },
      {
        name: "run",
        description: "Run command in task repo",
        options: [
          { type: 3, name: "task_id", description: "Task ID", required: true },
          { type: 3, name: "cmd", description: "Command", required: true }
        ]
      },
      {
        name: "open",
        description: "Open task in local VS Code",
        options: [{ type: 3, name: "task_id", description: "Task ID", required: true }]
      },
      {
        name: "read",
        description: "Read local file content",
        options: [
          { type: 3, name: "path", description: "File path (absolute or repo-relative)", required: true },
          { type: 3, name: "repo", description: "Repo id/path for relative file path", required: false },
          { type: 4, name: "start_line", description: "Start line (1-based)", required: false },
          { type: 4, name: "end_line", description: "End line (1-based)", required: false },
          { type: 4, name: "max_chars", description: "Max chars in reply (200-1400)", required: false }
        ]
      },
      {
        name: "repos",
        description: "List configured repos"
      },
      {
        name: "voice_join",
        description: "Join your current Discord voice channel"
      },
      {
        name: "voice_leave",
        description: "Leave current Discord voice channel"
      },
      {
        name: "voice_status",
        description: "Show voice channel connection status"
      },
      {
        name: "memory_add",
        description: "Add local memory for current user",
        options: [{ type: 3, name: "content", description: "Memory content", required: true }]
      },
      {
        name: "memory_list",
        description: "List local memories of current user",
        options: [
          { type: 4, name: "limit", description: "Limit 1-50", required: false },
          { type: 3, name: "scope", description: "user or system", required: false }
        ]
      },
      {
        name: "memory_delete",
        description: "Delete one memory item by id",
        options: [{ type: 4, name: "id", description: "Memory ID", required: true }]
      },
      {
        name: "memory_clear",
        description: "Clear all local memories of current user"
      },
      {
        name: "memory_auto",
        description: "Enable/disable Gemini automatic memory for current user",
        options: [{ type: 5, name: "enabled", description: "true=enable false=disable", required: true }]
      }
    ];

    await (this.bot as any).bulkEditCommands(commands);
    this.logger.info("Global slash commands registered");

    try {
      const guilds = Array.from((this.bot.guilds.values?.() ?? []) as any[]);
      for (const guild of guilds) {
        await (this.bot as any).bulkEditGuildCommands((guild as any).id, commands);
      }
      if (guilds.length > 0) {
        this.logger.info(`Guild slash commands registered for ${guilds.length} guild(s).`);
      }
    } catch (err) {
      this.logger.warn(`Guild slash registration skipped: ${(err as Error).message}`);
    }
  }

  private async handleTaskUpdate(event: any): Promise<void> {
    const channelId = event.channelId;
    if (!channelId) {
      return;
    }

    if (event.level === "stream") {
      for (const chunk of chunkText(event.message, 1800)) {
        await this.bot.createMessage(channelId, {
          content: `**[${event.taskId}] stream**\n\`\`\`\n${redactText(chunk)}\n\`\`\``
        });
      }
      return;
    }

    if (event.level === "plan") {
      const meta = event.metadata ?? {};
      const summary = String(meta.summary ?? "(no summary)");
      const steps = Array.isArray(meta.steps)
        ? (meta.steps as string[]).map((step, idx) => `${idx + 1}. ${step}`).join("\n")
        : "";
      const notes = Array.isArray(meta.notes)
        ? (meta.notes as string[]).map((note) => `- ${note}`).join("\n")
        : "";

      await this.bot.createMessage(channelId, {
        content:
          `**[${event.taskId}] Plan Ready (执行前确认)**\n` +
          `${summary}\n` +
          `${steps ? `步骤:\n${steps}\n` : ""}` +
          `${notes ? `注意:\n${notes}\n` : ""}` +
          "确认后才会开始执行。",
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 4,
                custom_id: `plan_no:${event.taskId}`,
                label: "取消计划"
              },
              {
                type: 2,
                style: 3,
                custom_id: `plan_yes:${event.taskId}`,
                label: "确认计划并开始"
              }
            ]
          }
        ]
      } as any);
      return;
    }

    if (event.level === "approval") {
      const meta = event.metadata ?? {};
      const files = Array.isArray(meta.changedFiles) ? meta.changedFiles.slice(0, 15).join("\n") : "";
      const summary = String(meta.summary ?? "(no summary)");
      const riskNotes = Array.isArray(meta.riskNotes) && meta.riskNotes.length > 0
        ? `\nRisk notes:\n- ${meta.riskNotes.join("\n- ")}`
        : "";

      await this.bot.createMessage(channelId, {
        content:
          `**[${event.taskId}] Patch Ready**\n` +
          `${summary}\n` +
          `Files: ${meta.changedFiles?.length ?? 0}, +${meta.addedLines ?? 0}/-${meta.deletedLines ?? 0}\n` +
          `${files ? `Changed files:\n${files}` : ""}${riskNotes}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 3,
                custom_id: `approve:${event.taskId}`,
                label: "Approve"
              },
              {
                type: 2,
                style: 4,
                custom_id: `reject:${event.taskId}`,
                label: "Reject"
              }
            ]
          }
        ]
      } as any);
      return;
    }

    if (event.level === "danger_confirm") {
      const token = String(event.metadata?.token ?? "");
      const command = String(event.metadata?.command ?? "");
      await this.bot.createMessage(channelId, {
        content: `**[${event.taskId}] Dangerous command confirmation required**\n\`${command}\``,
        components: [
          {
            type: 1,
            components: [
              {
                type: 2,
                style: 4,
                custom_id: `danger_no:${token}`,
                label: "Cancel"
              },
              {
                type: 2,
                style: 3,
                custom_id: `danger_yes:${token}`,
                label: "Confirm"
              }
            ]
          }
        ]
      } as any);
      return;
    }

    const prefix = event.level === "error" ? "ERROR" : "INFO";
    await this.bot.createMessage(channelId, {
      content: `**[${event.taskId}] ${prefix}** ${redactText(event.message)}`
    });
  }

  private async handleInteraction(interaction: any): Promise<void> {
    const type = interaction.type;

    if (type === Eris.Constants.InteractionTypes.APPLICATION_COMMAND) {
      await this.handleSlashCommand(interaction);
      return;
    }

    if (type === Eris.Constants.InteractionTypes.MESSAGE_COMPONENT) {
      await this.handleComponent(interaction);
    }
  }

  private getRolesFromInteraction(interaction: any): string[] {
    const roles = interaction.member?.roles;
    if (!roles) {
      return [];
    }
    return Array.isArray(roles) ? roles : [];
  }

  private async handleSlashCommand(interaction: any): Promise<void> {
    const access = this.accessControl.check({
      userId: interaction.member?.id ?? interaction.user?.id,
      channelId: interaction.channel.id,
      roleIds: this.getRolesFromInteraction(interaction)
    });

    if (!access.ok) {
      await interaction.createMessage({ content: `Access denied: ${access.reason}`, flags: 64 });
      return;
    }

    const commandName = interaction.data.name;
    const options = interaction.data.options as CommandOption[] | undefined;

    try {
      if (commandName === "ping") {
        const providerState = this.orchestrator.getPatchProviderState();
        await interaction.createMessage({
          content:
            `pong\\n` +
            `bot=${this.bot.user?.username ?? "unknown"}\\n` +
            `proxy=${this.config.discordProxyUrl ? "on" : "off"}\\n` +
            `speech=${this.speechAdapter ? "on" : "off"}\\n` +
            `gemini=${this.geminiAdapter ? "on" : "off"}\\n` +
            `gemini_model=${this.geminiAdapter ? this.config.geminiModel : "disabled"}\\n` +
            `patch_provider=${providerState.active}\\n` +
            `patch_provider_available=${providerState.available.join(",")}\\n` +
            `gemini_first=${this.config.geminiFirst ? "on" : "off"}\\n` +
            `memory_gemini_auto=${this.config.memoryGeminiAuto ? "on" : "off"}\\n` +
            `memory_context_limit=${this.config.memoryContextLimit}\\n` +
            `user_context_limit=${this.config.userContextLimit}\\n` +
            `user_context_retention_days=${this.config.userContextRetentionDays}\\n` +
            `evolution_enabled=${this.config.evolutionEnabled ? "on" : "off"}\\n` +
            `evolution_interval_minutes=${this.config.evolutionIntervalMinutes}\\n` +
            `plan_approval=${this.config.planApprovalRequired ? "on" : "off"}\\n` +
            `require_trigger=${this.config.requireTrigger ? "on" : "off"}\\n` +
            `allow_local_path_repo=${this.config.allowLocalPathRepo ? "on" : "off"}\\n` +
            `auto_stash_before_apply=${this.config.autoStashBeforeApply ? "on" : "off"}\\n` +
            `prefix=${this.config.botPrefix}\\n` +
            `hint=If @bot text has no response, enable MESSAGE CONTENT INTENT in Discord Developer Portal and ensure bot has View/Send/Read Message History permissions.`,
          flags: 64
        });
        return;
      }

      if (commandName === "provider") {
        const modeRaw = getOption(options, "mode");
        if (modeRaw === undefined || modeRaw === null || String(modeRaw).trim() === "") {
          const state = this.orchestrator.getPatchProviderState();
          await interaction.createMessage({
            content:
              `patch_provider=${state.active}\n` +
              `display=${state.displayName}\n` +
              `available=${state.available.join(",")}`,
            flags: 64
          });
          return;
        }

        const mode = String(modeRaw).trim().toLowerCase();
        if (!["auto", "codex", "gemini"].includes(mode)) {
          await interaction.createMessage({
            content: "mode 仅支持 auto/codex/gemini",
            flags: 64
          });
          return;
        }

        const state = this.orchestrator.setPatchProvider(mode as "auto" | "codex" | "gemini");
        await interaction.createMessage({
          content:
            `已切换 patch_provider=${state.active}\n` +
            `display=${state.displayName}\n` +
            `available=${state.available.join(",")}`,
          flags: 64
        });
        return;
      }

      if (commandName === "task") {
        const repo = String(getOption(options, "repo"));
        const prompt = String(getOption(options, "prompt"));
        const baseBranch = getOption(options, "base_branch") as string | undefined;
        const testProfile = getOption(options, "test_profile") as string | undefined;
        const openVsCode = Boolean(getOption(options, "open_vscode") ?? false);
        const repoResolution = this.resolveRepoIdInput(repo);
        if (!repoResolution.ok) {
          await interaction.createMessage({ content: repoResolution.message, flags: 64 });
          return;
        }

        const task = this.orchestrator.createTask({
          repoId: repoResolution.repoId,
          prompt,
          requesterUserId: interaction.member?.id ?? interaction.user?.id,
          requesterChannelId: interaction.channel.id,
          baseBranch,
          testProfile,
          openVsCode
        });

        await interaction.createMessage({
          content: `Task accepted: ${task.taskId} (repo=${task.repoId}, status=${task.status})`,
          flags: 64
        });
        return;
      }

      if (commandName === "status") {
        const taskId = String(getOption(options, "task_id"));
        const status = this.orchestrator.getStatus(taskId);
        const eventLines = status.events
          .slice(0, 8)
          .map((e) => `- [${e.level}] ${e.message}`)
          .join("\n");
        await interaction.createMessage({
          content:
            `Task: ${status.task.taskId}\n` +
            `Status: ${status.task.status}\n` +
            `Repo: ${status.task.repoId}\n` +
            `Branch: ${status.task.branchName}\n` +
            `${status.task.committedHash ? `Commit: ${status.task.committedHash}\n` : ""}` +
            `${eventLines ? `Recent events:\n${eventLines}` : ""}`,
          flags: 64
        });
        return;
      }

      if (commandName === "approve") {
        const taskId = String(getOption(options, "task_id"));
        void this.orchestrator
          .approveTask(taskId, interaction.member?.id ?? interaction.user?.id)
          .catch((err) => {
            this.logger.error(`Approve failed for ${taskId}: ${(err as Error).message}`);
            void this.bot.createMessage(interaction.channel.id, {
              content: `**[${taskId}] ERROR** ${redactText((err as Error).message)}`
            });
          });
        await interaction.createMessage({
          content: `Approve accepted, running in background: ${taskId}`,
          flags: 64
        });
        return;
      }

      if (commandName === "reject") {
        const taskId = String(getOption(options, "task_id"));
        const reason = getOption(options, "reason") as string | undefined;
        this.orchestrator.rejectTask(taskId, interaction.member?.id ?? interaction.user?.id, reason);
        await interaction.createMessage({ content: `Rejected: ${taskId}`, flags: 64 });
        return;
      }

      if (commandName === "cancel") {
        const taskId = String(getOption(options, "task_id"));
        this.orchestrator.cancelTask(taskId, interaction.member?.id ?? interaction.user?.id);
        await interaction.createMessage({ content: `Cancelled: ${taskId}`, flags: 64 });
        return;
      }

      if (commandName === "run") {
        const taskId = String(getOption(options, "task_id"));
        const cmd = String(getOption(options, "cmd"));
        const result = await this.orchestrator.runCommand(
          taskId,
          interaction.member?.id ?? interaction.user?.id,
          interaction.channel.id,
          cmd
        );

        if (result.type === "needs_confirmation") {
          await interaction.createMessage({
            content: `Dangerous command queued for confirmation. token=${result.token}`,
            flags: 64
          });
          return;
        }

        await interaction.createMessage({
          content:
            `Command exit: ${result.result.exitCode}\n` +
            `stdout:\n\`\`\`\n${redactText(result.result.stdout).slice(0, 1400)}\n\`\`\`\n` +
            `stderr:\n\`\`\`\n${redactText(result.result.stderr).slice(0, 900)}\n\`\`\``,
          flags: 64
        });
        return;
      }

      if (commandName === "open") {
        const taskId = String(getOption(options, "task_id"));
        await this.orchestrator.openInVSCode(taskId);
        await interaction.createMessage({ content: `Opened in VS Code: ${taskId}`, flags: 64 });
        return;
      }

      if (commandName === "read") {
        const filePath = String(getOption(options, "path") ?? "").trim();
        const repoArg = getOption(options, "repo");
        const startLine = getOption(options, "start_line");
        const endLine = getOption(options, "end_line");
        const maxChars = getOption(options, "max_chars");
        const content = this.readLocalFileReply(
          filePath,
          repoArg ? String(repoArg) : undefined,
          startLine,
          endLine,
          maxChars
        );
        await interaction.createMessage({ content, flags: 64 });
        return;
      }

      if (commandName === "repos") {
        const repos = this.orchestrator.listRepos();
        const lines = repos
          .map((r) => `- ${r.id} (${r.defaultBaseBranch}) path=${r.path} profiles=${r.profiles.join(",") || "none"}`)
          .join("\n");
        await interaction.createMessage({ content: lines || "No repos configured", flags: 64 });
        return;
      }

      if (commandName === "voice_join") {
        const guildId = String(interaction.guildID ?? interaction.guildId ?? "");
        const userVoiceChannelId = interaction.member?.voiceState?.channelID ?? interaction.member?.voiceState?.channelId;
        if (!guildId) {
          await interaction.createMessage({ content: "该命令只能在服务器频道内使用。", flags: 64 });
          return;
        }
        if (!userVoiceChannelId) {
          await interaction.createMessage({ content: "请先加入一个语音频道。", flags: 64 });
          return;
        }
        await this.bot.joinVoiceChannel(String(userVoiceChannelId));
        await interaction.createMessage({
          content: `已加入语音频道: ${String(userVoiceChannelId)}（当前支持入会待命，实时语音理解后续增强）`,
          flags: 64
        });
        return;
      }

      if (commandName === "voice_leave") {
        const guildId = String(interaction.guildID ?? interaction.guildId ?? "");
        if (!guildId) {
          await interaction.createMessage({ content: "该命令只能在服务器频道内使用。", flags: 64 });
          return;
        }
        const joinedChannelId = this.getJoinedVoiceChannelId(guildId);
        if (!joinedChannelId) {
          await interaction.createMessage({ content: "当前未加入语音频道。", flags: 64 });
          return;
        }
        this.bot.leaveVoiceChannel(joinedChannelId);
        await interaction.createMessage({ content: "已离开语音频道。", flags: 64 });
        return;
      }

      if (commandName === "voice_status") {
        const guildId = String(interaction.guildID ?? interaction.guildId ?? "");
        if (!guildId) {
          await interaction.createMessage({ content: "该命令只能在服务器频道内使用。", flags: 64 });
          return;
        }
        const joinedChannelId = this.getJoinedVoiceChannelId(guildId);
        await interaction.createMessage({
          content: joinedChannelId ? `voice=connected channel=${joinedChannelId}` : "voice=disconnected",
          flags: 64
        });
        return;
      }

      if (commandName === "memory_add") {
        const content = String(getOption(options, "content") ?? "").trim();
        if (!content) {
          await interaction.createMessage({ content: "content 不能为空。", flags: 64 });
          return;
        }
        const userId = interaction.member?.id ?? interaction.user?.id;
        const result = this.stateStore.upsertMemory(userId, interaction.channel.id, content, "manual");
        await interaction.createMessage({
          content:
            `${result.created ? "已新增" : "已更新"}记忆 #${result.record.id}：` +
            `${result.record.content.slice(0, 120)}`,
          flags: 64
        });
        return;
      }

      if (commandName === "memory_list") {
        const userId = interaction.member?.id ?? interaction.user?.id;
        const limit = Number(getOption(options, "limit") ?? 10);
        const scope = String(getOption(options, "scope") ?? "user").trim().toLowerCase();
        const targetUserId = scope === "system" ? SYSTEM_MEMORY_USER_ID : userId;
        const rows = this.stateStore.listMemories(targetUserId, limit);
        if (rows.length === 0) {
          await interaction.createMessage({
            content: scope === "system" ? "暂无系统进化记忆。" : "暂无本地记忆。",
            flags: 64
          });
          return;
        }
        const lines = rows
          .map((row) => `#${row.id} [${row.source}] ${row.content}`)
          .join("\n");
        const auto = this.stateStore.isAutoMemoryEnabled(userId);
        await interaction.createMessage({
          content:
            `scope=${scope === "system" ? "system" : "user"}\n` +
            `memory_auto=${auto ? "on" : "off"}\n` +
            `${lines}`,
          flags: 64
        });
        return;
      }

      if (commandName === "memory_delete") {
        const userId = interaction.member?.id ?? interaction.user?.id;
        const id = Number(getOption(options, "id"));
        if (!Number.isFinite(id) || id <= 0) {
          await interaction.createMessage({ content: "id 必须是正整数。", flags: 64 });
          return;
        }
        const deleted = this.stateStore.deleteMemory(userId, id);
        await interaction.createMessage({
          content: deleted ? `已删除记忆 #${id}` : `未找到记忆 #${id}`,
          flags: 64
        });
        return;
      }

      if (commandName === "memory_clear") {
        const userId = interaction.member?.id ?? interaction.user?.id;
        const count = this.stateStore.clearMemories(userId);
        await interaction.createMessage({
          content: `已清空本地记忆，删除 ${count} 条。`,
          flags: 64
        });
        return;
      }

      if (commandName === "memory_auto") {
        const userId = interaction.member?.id ?? interaction.user?.id;
        const enabled = Boolean(getOption(options, "enabled"));
        this.stateStore.setAutoMemoryEnabled(userId, enabled);
        await interaction.createMessage({
          content: `已设置 memory_auto=${enabled ? "on" : "off"}`,
          flags: 64
        });
        return;
      }

      await interaction.createMessage({ content: "Unsupported command", flags: 64 });
    } catch (err) {
      await interaction.createMessage({
        content: `Command failed: ${(err as Error).message}`,
        flags: 64
      });
    }
  }

  private async handleComponent(interaction: any): Promise<void> {
    const customId = interaction.data.custom_id as string;
    const userId = interaction.member?.id ?? interaction.user?.id;
    const access = this.accessControl.check({
      userId,
      channelId: interaction.channel.id,
      roleIds: this.getRolesFromInteraction(interaction)
    });

    if (!access.ok) {
      await interaction.createMessage({ content: `Access denied: ${access.reason}`, flags: 64 });
      return;
    }

    try {
      if (customId.startsWith("approve:")) {
        const taskId = customId.slice("approve:".length);
        void this.orchestrator.approveTask(taskId, userId).catch((err) => {
          this.logger.error(`Approve failed for ${taskId}: ${(err as Error).message}`);
          void this.bot.createMessage(interaction.channel.id, {
            content: `**[${taskId}] ERROR** ${redactText((err as Error).message)}`
          });
        });
        await interaction.createMessage({
          content: `Approved ${taskId}, execution started in background.`,
          flags: 64
        });
        return;
      }

      if (customId.startsWith("plan_yes:")) {
        const taskId = customId.slice("plan_yes:".length);
        void this.orchestrator.approveTask(taskId, userId).catch((err) => {
          this.logger.error(`Plan approve failed for ${taskId}: ${(err as Error).message}`);
          void this.bot.createMessage(interaction.channel.id, {
            content: `**[${taskId}] ERROR** ${redactText((err as Error).message)}`
          });
        });
        await interaction.createMessage({
          content: `Plan approved: ${taskId}. Execution started in background.`,
          flags: 64
        });
        return;
      }

      if (customId.startsWith("plan_no:")) {
        const taskId = customId.slice("plan_no:".length);
        this.orchestrator.rejectTask(taskId, userId, "Plan rejected by user");
        await interaction.createMessage({ content: `Plan canceled: ${taskId}`, flags: 64 });
        return;
      }

      if (customId.startsWith("reject:")) {
        const taskId = customId.slice("reject:".length);
        this.orchestrator.rejectTask(taskId, userId);
        await interaction.createMessage({ content: `Rejected ${taskId}`, flags: 64 });
        return;
      }

      if (customId.startsWith("danger_yes:")) {
        const token = customId.slice("danger_yes:".length);
        const result = await this.orchestrator.confirmDangerousCommand(token, userId);
        await interaction.createMessage({
          content:
            `Danger command executed. exit=${result.exitCode}\n` +
            `stdout:\n\`\`\`\n${redactText(result.stdout).slice(0, 1200)}\n\`\`\``,
          flags: 64
        });
        return;
      }

      if (customId.startsWith("danger_no:")) {
        const token = customId.slice("danger_no:".length);
        this.orchestrator.cancelPendingConfirmation(token, userId);
        await interaction.createMessage({
          content: "Dangerous command canceled.",
          flags: 64
        });
        return;
      }

      if (customId.startsWith("nl_yes:")) {
        const token = customId.slice("nl_yes:".length);
        const pending = this.orchestrator.consumeNlConfirmation(token, userId);
        const payload = pending.payload as any;
        await this.executeParsedNl(payload, interaction.channel.id, userId, interaction);
        return;
      }

      if (customId.startsWith("nl_no:")) {
        const token = customId.slice("nl_no:".length);
        this.orchestrator.cancelPendingConfirmation(token, userId);
        await interaction.createMessage({ content: "Natural-language command canceled.", flags: 64 });
        return;
      }

      await interaction.createMessage({ content: "Unknown action", flags: 64 });
    } catch (err) {
      await interaction.createMessage({
        content: `Action failed: ${(err as Error).message}`,
        flags: 64
      });
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg.author.bot) {
      return;
    }

    const userId = msg.author.id;
    const channelId = msg.channel.id;
    const botId = this.bot.user.id;
    const content = String(msg.content ?? "");
    const access = this.accessControl.check({
      userId,
      channelId,
      roleIds: Array.isArray(msg.member?.roles) ? msg.member.roles : []
    });

    const mentioned = isMentionedMessage(msg, botId);
    const prefixed = isTriggered(content, this.config.botPrefix, botId);
    const commandActivated = mentioned || prefixed;
    const textActivated = commandActivated || !this.config.requireTrigger;
    const audioAttachment = this.pickAudioAttachment(msg);

    if (textActivated || audioAttachment) {
      this.logger.info(
        `message event user=${userId} channel=${channelId} mentioned=${mentioned} prefixed=${prefixed} commandActivated=${commandActivated} textActivated=${textActivated} audio=${Boolean(audioAttachment)}`
      );
    }

    if (!access.ok) {
      if (mentioned || prefixed || audioAttachment) {
        await this.bot.createMessage(channelId, `Access denied: ${access.reason}`);
      }
      return;
    }

    if (audioAttachment && !this.speechAdapter) {
      await this.bot.createMessage(
        channelId,
        "检测到语音消息，但未配置语音识别。请在 .env 设置 GOOGLE_API_KEY。"
      );
      return;
    }

    if (audioAttachment && this.speechAdapter) {
      await this.handleVoiceMessage(msg, audioAttachment);
      return;
    }

    if (!textActivated) {
      return;
    }

    const input = stripTrigger(content, this.config.botPrefix, botId);
    const parsed = commandActivated
      ? parseNaturalLanguageCommand(content, this.config.botPrefix, botId)
      : null;
    const allowImplicitTaskIntent = commandActivated;
    const recentUserInputs = this.getRecentUserContext(userId, channelId);
    const recentConversation = this.getRecentConversationContext(userId, channelId);
    const contextualRead = commandActivated
      ? this.tryBuildReadCommandFromContext(input, recentUserInputs)
      : null;
    const parsedFinal =
      commandActivated
        ? parsed ??
          parseNaturalLanguageFreeText(input, {
            defaultRepoId: this.getDefaultRepoId(),
            allowImplicitTaskIntent
          }) ??
          contextualRead
        : null;
    const inputBrief = input.length > 80 ? `${input.slice(0, 80)}...` : input;
    this.saveUserContextInput(userId, channelId, input);
    const memoryContext = this.getUserMemoryContext(userId);
    const geminiMode = commandActivated ? "auto" : "reply_only";

    let geminiFailureMessage: string | null = null;
    let geminiTried = false;
    const maybeAskGemini = async (): Promise<boolean> => {
      if (parsedFinal || !this.geminiAdapter) {
        return false;
      }
      try {
        geminiTried = true;
        const ai = await this.geminiAdapter.interpretUserText(
          input,
          this.getDefaultRepoId(),
          this.listRepoIds(),
          this.config.allowLocalPathRepo,
          memoryContext,
          recentConversation,
          geminiMode
        );
        this.trySaveGeminiMemory(userId, channelId, ai.memoryToSave);
        if (ai.command) {
          if (!commandActivated) {
            this.logger.info(`nl route=gemini_command_ignored text="${inputBrief}"`);
            return false;
          }
          this.logger.info(`nl route=gemini_command command=${ai.command.slashCommand} text="${inputBrief}"`);
          await this.sendNlConfirmation(ai.command, userId, channelId);
          return true;
        }
        if (ai.reply) {
          this.logger.info(`nl route=gemini_reply text="${inputBrief}"`);
          await this.bot.createMessage(channelId, ai.reply);
          this.saveAssistantContextOutput(userId, channelId, ai.reply);
          return true;
        }
        this.logger.info(`nl route=gemini_none text="${inputBrief}"`);
      } catch (err) {
        geminiFailureMessage = (err as Error).message;
        this.logger.warn(`Gemini assist failed: ${geminiFailureMessage}`);
      }
      return false;
    };

    if (!parsedFinal && this.config.geminiFirst) {
      if (await maybeAskGemini()) {
        return;
      }
    }

    if (!parsedFinal) {
      const localReply = tryLocalIntentReply(input, this.getDefaultRepoId());
      if (localReply) {
        this.logger.info(`nl route=local_reply implicitTask=${allowImplicitTaskIntent} text="${inputBrief}"`);
        await this.bot.createMessage(channelId, localReply);
        this.saveAssistantContextOutput(userId, channelId, localReply);
        return;
      }
    }

    if (!parsedFinal && !this.config.geminiFirst && !geminiTried) {
      if (await maybeAskGemini()) {
        return;
      }
    }

    if (!parsedFinal) {
      this.logger.info(`nl route=fallback implicitTask=${allowImplicitTaskIntent} text="${inputBrief}"`);
      const fallbackReply = buildContextualFallbackReply(input, this.getDefaultRepoId(), geminiFailureMessage);
      await this.bot.createMessage(
        channelId,
        fallbackReply
      );
      this.saveAssistantContextOutput(userId, channelId, fallbackReply);
      return;
    }

    this.logger.info(`nl route=rule_command command=${parsedFinal.slashCommand} implicitTask=${allowImplicitTaskIntent} text="${inputBrief}"`);
    await this.sendNlConfirmation(parsedFinal, userId, channelId);
  }

  private async handleVoiceMessage(msg: any, attachment: any): Promise<void> {
    if (!this.speechAdapter) {
      return;
    }
    try {
      await this.bot.createMessage(msg.channel.id, "收到语音，正在识别...");
      const transcript = await this.speechAdapter.transcribeAttachment(
        String(attachment.url),
        attachment.content_type ?? attachment.contentType ?? null
      );

      if (!transcript) {
        await this.bot.createMessage(msg.channel.id, "语音识别失败：没有识别到可用内容。");
        return;
      }

      await this.bot.createMessage(msg.channel.id, `语音识别：${transcript}`);
      const recentUserInputs = this.getRecentUserContext(msg.author.id, msg.channel.id);
      const recentConversation = this.getRecentConversationContext(msg.author.id, msg.channel.id);
      const parsedDirect = parseNaturalLanguageBody(transcript);
      const parsedFree =
        parsedDirect ??
        parseNaturalLanguageFreeText(transcript, {
          defaultRepoId: this.getDefaultRepoId(),
          allowImplicitTaskIntent: true
        });
      const parsed = parsedFree ?? this.tryBuildReadCommandFromContext(transcript, recentUserInputs);
      let geminiFailureMessage: string | null = null;
      const allowLocalPathRepo = this.config.allowLocalPathRepo;
      this.saveUserContextInput(msg.author.id, msg.channel.id, transcript);
      const memoryContext = this.getUserMemoryContext(msg.author.id);
      if (!parsed && this.geminiAdapter) {
        try {
          const ai = await this.geminiAdapter.interpretUserText(
            transcript,
            this.getDefaultRepoId(),
            this.listRepoIds(),
            allowLocalPathRepo,
            memoryContext,
            recentConversation
          );
          this.trySaveGeminiMemory(msg.author.id, msg.channel.id, ai.memoryToSave);
          if (ai.command) {
            await this.sendNlConfirmation(ai.command, msg.author.id, msg.channel.id);
            return;
          }
          if (ai.reply) {
            await this.bot.createMessage(msg.channel.id, ai.reply);
            this.saveAssistantContextOutput(msg.author.id, msg.channel.id, ai.reply);
            return;
          }
        } catch (err) {
          geminiFailureMessage = (err as Error).message;
          this.logger.warn(`Gemini voice assist failed: ${geminiFailureMessage}`);
        }
      }

      if (!parsed) {
        const localReply = tryLocalIntentReply(transcript, this.getDefaultRepoId());
        if (localReply) {
          await this.bot.createMessage(msg.channel.id, localReply);
          this.saveAssistantContextOutput(msg.author.id, msg.channel.id, localReply);
          return;
        }
      }

      if (!parsed) {
        const fallbackReply = buildContextualFallbackReply(
          transcript,
          this.getDefaultRepoId(),
          geminiFailureMessage
        );
        await this.bot.createMessage(
          msg.channel.id,
          fallbackReply
        );
        this.saveAssistantContextOutput(msg.author.id, msg.channel.id, fallbackReply);
        return;
      }

      await this.sendNlConfirmation(parsed, msg.author.id, msg.channel.id);
    } catch (err) {
      await this.bot.createMessage(
        msg.channel.id,
        `语音处理失败：${(err as Error).message}`
      );
    }
  }

  private pickAudioAttachment(msg: any): any | null {
    if (!this.speechAdapter) {
      return null;
    }
    const attachments = getAttachments(msg);
    for (const item of attachments) {
      if (this.speechAdapter.isAudioAttachment(item)) {
        return item;
      }
    }
    return null;
  }

  private async sendNlConfirmation(
    parsed: ParsedNlPayload,
    userId: string,
    channelId: string
  ): Promise<void> {
    const normalized = this.normalizeParsedCommand(parsed);
    if (!normalized.ok) {
      await this.bot.createMessage(channelId, normalized.message);
      return;
    }

    const token = this.orchestrator.createNlConfirmation("nl", userId, channelId, {
      slashCommand: normalized.parsed.slashCommand,
      args: normalized.parsed.args
    });

    await this.bot.createMessage(channelId, {
      content: `请确认执行: ${normalized.parsed.preview}`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 4,
              custom_id: `nl_no:${token}`,
              label: "取消"
            },
            {
              type: 2,
              style: 3,
              custom_id: `nl_yes:${token}`,
              label: "确认执行"
            }
          ]
        }
      ]
    } as any);
  }

  private getUserMemoryContext(userId: string): string[] {
    const limit = Math.max(1, Math.min(20, this.config.memoryContextLimit));
    const systemCap = Math.max(1, Math.floor(limit / 2));
    const userCap = Math.max(1, limit - systemCap);

    const systemMemories = this.stateStore
      .listMemories(SYSTEM_MEMORY_USER_ID, systemCap)
      .map((item) => item.content);
    const userMemories = this.stateStore
      .listMemories(userId, userCap)
      .map((item) => item.content);

    return [...systemMemories, ...userMemories].filter((item) => item.trim().length > 0);
  }

  private getRecentConversationContext(userId: string, channelId: string): string[] {
    const limit = Math.max(1, Math.min(30, this.config.userContextLimit));
    return this.stateStore
      .listRecentUserContext(userId, channelId, limit)
      .map((item) => {
        const parsed = this.parseContextEntry(item.content);
        if (!parsed.content) {
          return null;
        }
        return `${parsed.role === "assistant" ? "A" : "U"}: ${parsed.content}`;
      })
      .filter((item): item is string => Boolean(item));
  }

  private getRecentUserContext(userId: string, channelId: string): string[] {
    const limit = Math.max(1, Math.min(30, this.config.userContextLimit));
    return this.stateStore
      .listRecentUserContext(userId, channelId, limit)
      .map((item) => this.parseContextEntry(item.content))
      .filter((item) => item.role === "user" && item.content.length > 0)
      .map((item) => item.content)
      .filter((item) => item.trim().length > 0);
  }

  private saveUserContextInput(userId: string, channelId: string, content: string): void {
    const text = String(content ?? "").trim();
    if (!text) {
      return;
    }

    try {
      this.stateStore.addUserContextMessage(userId, channelId, `U: ${text}`);
    } catch (err) {
      this.logger.warn(`[context] save failed: ${(err as Error).message}`);
    }
  }

  private saveAssistantContextOutput(userId: string, channelId: string, content: string): void {
    const text = String(content ?? "").trim().replace(/\s+/g, " ");
    if (!text) {
      return;
    }

    const compact = text.slice(0, 800);
    try {
      this.stateStore.addUserContextMessage(userId, channelId, `A: ${compact}`);
    } catch (err) {
      this.logger.warn(`[context] save failed: ${(err as Error).message}`);
    }
  }

  private parseContextEntry(rawContent: string): { role: "user" | "assistant"; content: string } {
    const text = String(rawContent ?? "").trim();
    if (!text) {
      return { role: "user", content: "" };
    }

    const prefixed = text.match(/^([UA]):\s*(.*)$/);
    if (!prefixed) {
      return { role: "user", content: text };
    }

    return {
      role: prefixed[1] === "A" ? "assistant" : "user",
      content: String(prefixed[2] ?? "").trim()
    };
  }

  private trySaveGeminiMemory(userId: string, channelId: string, memoryToSave: string | null): void {
    const text = String(memoryToSave ?? "").trim();
    if (!text) {
      return;
    }
    if (!this.config.memoryGeminiAuto) {
      return;
    }
    if (!this.stateStore.isAutoMemoryEnabled(userId)) {
      return;
    }

    try {
      const result = this.stateStore.upsertMemory(userId, channelId, text, "gemini");
      this.logger.info(
        `[memory] ${result.created ? "created" : "updated"} user=${userId} id=${result.record.id} source=gemini`
      );
    } catch (err) {
      this.logger.warn(`[memory] save failed: ${(err as Error).message}`);
    }
  }

  private listRepoIds(): string[] {
    return this.orchestrator.listRepos().map((repo) => repo.id);
  }

  private getJoinedVoiceChannelId(guildId: string): string | null {
    const connections = (this.bot as any).voiceConnections;
    if (!connections) {
      return null;
    }

    const entry = connections.get ? connections.get(guildId) : connections[guildId];
    if (!entry) {
      return null;
    }
    const channelId = entry.channelID ?? entry.channelId;
    return channelId ? String(channelId) : null;
  }

  private resolveRepoIdInput(inputRepo: string): { ok: true; repoId: string } | { ok: false; message: string } {
    const raw = String(inputRepo ?? "").trim();
    const repos = this.orchestrator.listRepos();
    const repoIds = repos.map((repo) => repo.id);

    if (!raw) {
      return {
        ok: false,
        message: "缺少 repo 参数。请先用 /repos 查看可用仓库 ID，再用 /task repo=<id> prompt=..."
      };
    }

    const direct = repos.find((repo) => repo.id === raw);
    if (direct) {
      return { ok: true, repoId: direct.id };
    }

    if (this.looksLikePath(raw)) {
      const normalizedInput = this.normalizePath(raw);
      const matched = repos.find((repo) => this.normalizePath(repo.path) === normalizedInput);
      if (matched) {
        return { ok: true, repoId: matched.id };
      }

      if (this.config.allowLocalPathRepo) {
        return { ok: true, repoId: raw };
      }

      return {
        ok: false,
        message:
          "当前禁用了本地路径 repo。请改用白名单仓库 ID，或在 .env 设置 ALLOW_LOCAL_PATH_REPO=true。"
      };
    }

    return {
      ok: false,
      message:
        `未知 repo: ${raw}。可用 repo: ${repoIds.join(", ") || "(none)"}。` +
        " 先用 /repos 查看详情。"
    };
  }

  private readLocalFileReply(
    rawPath: string,
    repoArg?: string,
    startLineInput?: unknown,
    endLineInput?: unknown,
    maxCharsInput?: unknown
  ): string {
    const resolved = this.resolveReadableFilePath(rawPath, repoArg);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${resolved}`);
    }
    if (stat.size > 2 * 1024 * 1024) {
      throw new Error(`File too large (>2MB): ${resolved}`);
    }

    const raw = fs.readFileSync(resolved, "utf8");
    if (raw.includes("\u0000")) {
      throw new Error("Binary file is not supported. Please provide a text file.");
    }

    const lines = raw.split(/\r?\n/);
    const startLine = this.parseBoundedInt(startLineInput, 1, lines.length, 1);
    const endLine = this.parseBoundedInt(endLineInput, startLine, lines.length, lines.length);
    const selected = lines.slice(startLine - 1, endLine).join("\n");
    const maxChars = this.parseBoundedInt(maxCharsInput, 200, 1400, 1200);
    const output = selected.slice(0, maxChars);
    const truncated = selected.length > maxChars;

    return (
      `file=${resolved}\n` +
      `lines=${startLine}-${endLine}, chars=${output.length}${truncated ? `/${selected.length}` : ""}\n` +
      "```text\n" +
      `${redactText(output)}\n` +
      "```" +
      (truncated ? "\n(内容已截断。可用 start_line/end_line 或更小范围重试)" : "")
    );
  }

  private resolveReadableFilePath(rawPath: string, repoArg?: string): string {
    const input = String(rawPath ?? "").trim();
    if (!input) {
      throw new Error("Missing file path.");
    }

    const repos = this.orchestrator.listRepos();
    const repoRoots = repos.map((repo) => path.resolve(repo.path));

    let basePath: string | null = null;
    if (repoArg && repoArg.trim()) {
      basePath = this.resolveRepoBasePath(repoArg.trim());
    } else if (!path.isAbsolute(input)) {
      const defaultRepoId = this.getDefaultRepoId();
      if (!defaultRepoId) {
        throw new Error("Relative path requires repo parameter when multiple repos exist.");
      }
      const defaultRepo = repos.find((repo) => repo.id === defaultRepoId);
      if (!defaultRepo) {
        throw new Error(`Default repo not found: ${defaultRepoId}`);
      }
      basePath = path.resolve(defaultRepo.path);
    }

    const resolved = basePath ? path.resolve(basePath, input) : path.resolve(input);
    if (basePath && !this.isPathInside(resolved, basePath)) {
      throw new Error(`Path escapes repo root: ${resolved}`);
    }

    if (!basePath && path.isAbsolute(input) && !this.config.allowLocalPathRepo) {
      const insideKnownRepo = repoRoots.some((root) => this.isPathInside(resolved, root));
      if (!insideKnownRepo) {
        throw new Error("Absolute path is disabled. Enable ALLOW_LOCAL_PATH_REPO or use repo-relative path.");
      }
    }

    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    return resolved;
  }

  private resolveRepoBasePath(repoArg: string): string {
    const repos = this.orchestrator.listRepos();
    const direct = repos.find((repo) => repo.id === repoArg);
    if (direct) {
      return path.resolve(direct.path);
    }

    if (!this.looksLikePath(repoArg)) {
      throw new Error(`Unknown repo: ${repoArg}`);
    }
    if (!this.config.allowLocalPathRepo) {
      throw new Error("Local path repo is disabled. Enable ALLOW_LOCAL_PATH_REPO.");
    }

    const resolved = path.resolve(repoArg);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`Repo path not found: ${resolved}`);
    }
    return resolved;
  }

  private parseBoundedInt(
    input: unknown,
    min: number,
    max: number,
    defaultValue: number
  ): number {
    const parsed = Number(input ?? defaultValue);
    if (!Number.isFinite(parsed)) {
      return defaultValue;
    }
    const rounded = Math.trunc(parsed);
    if (rounded < min) {
      return min;
    }
    if (rounded > max) {
      return max;
    }
    return rounded;
  }

  private isPathInside(targetPath: string, rootPath: string): boolean {
    const normalizedTarget = this.normalizePath(targetPath);
    const normalizedRoot = this.normalizePath(rootPath);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  }

  private tryBuildReadCommandFromContext(
    input: string,
    recentUserInputs: string[]
  ): ParsedNlPayload | null {
    if (!/(读取|读一下|读出|查看文件|读文件|read file|read|cat)/i.test(input)) {
      return null;
    }
    if (this.extractPathFromText(input)) {
      return null;
    }

    const previousPath = [...recentUserInputs]
      .reverse()
      .map((item) => this.extractPathFromText(item))
      .find((item): item is string => Boolean(item));

    if (!previousPath) {
      return null;
    }

    return {
      slashCommand: "read",
      args: { path: previousPath },
      preview: `/read path=${previousPath}`
    };
  }

  private extractPathFromText(text: string): string | null {
    const quoted = text.match(/["'`](?<path>(?:[a-zA-Z]:\\|\/)[^"'`]+)["'`]/);
    const fromQuoted = quoted?.groups?.path?.trim();
    if (fromQuoted) {
      return fromQuoted;
    }

    const win = text.match(/[a-zA-Z]:\\[^\s"'`，。,；;）)]+/);
    if (win?.[0]) {
      return win[0].trim();
    }

    const unix = text.match(/\/[^\s"'`，。,；;）)]+/);
    if (unix?.[0]) {
      return unix[0].trim();
    }

    return null;
  }

  private normalizeParsedCommand(
    parsed: ParsedNlPayload
  ): { ok: true; parsed: ParsedNlPayload } | { ok: false; message: string } {
    if (parsed.slashCommand === "read") {
      const filePath = String(parsed.args.path ?? "").trim();
      if (!filePath) {
        return { ok: false, message: "缺少 path。示例：/read path:D:\\work\\sample-repo\\README.md" };
      }
      return { ok: true, parsed };
    }

    if (parsed.slashCommand !== "task") {
      return { ok: true, parsed };
    }

    const rawRepo = String(parsed.args.repo ?? "").trim();
    const repoResolution = this.resolveRepoIdInput(rawRepo);
    if (!repoResolution.ok) {
      return repoResolution;
    }

    const prompt = String(parsed.args.prompt ?? "").trim();
    if (!prompt) {
      return { ok: false, message: "缺少 prompt。请补充你希望修改的内容。" };
    }

    const next: ParsedNlPayload = {
      slashCommand: "task",
      args: {
        ...parsed.args,
        repo: repoResolution.repoId,
        prompt
      },
      preview: parsed.preview.replace(String(parsed.args.repo ?? ""), repoResolution.repoId)
    };
    return { ok: true, parsed: next };
  }

  private looksLikePath(value: string): boolean {
    return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\") || value.includes("/");
  }

  private normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return resolved.replace(/\\/g, "/").toLowerCase();
  }

  private getDefaultRepoId(): string | null {
    const repos = this.orchestrator.listRepos();
    if (repos.length === 1) {
      return repos[0].id;
    }
    return null;
  }

  private async executeParsedNl(
    payload: { slashCommand: string; args: Record<string, any> },
    channelId: string,
    userId: string,
    interaction: any
  ): Promise<void> {
    const { slashCommand, args } = payload;

    if (slashCommand === "ping") {
      const providerState = this.orchestrator.getPatchProviderState();
      await interaction.createMessage({
        content:
          `pong (prefix=${this.config.botPrefix}, speech=${this.speechAdapter ? "on" : "off"}, ` +
          `gemini=${this.geminiAdapter ? "on" : "off"}, ` +
          `gemini_model=${this.geminiAdapter ? this.config.geminiModel : "disabled"}, ` +
          `patch_provider=${providerState.active}, ` +
          `patch_provider_available=${providerState.available.join("|")}, ` +
          `gemini_first=${this.config.geminiFirst ? "on" : "off"}, ` +
          `memory_gemini_auto=${this.config.memoryGeminiAuto ? "on" : "off"}, ` +
          `memory_context_limit=${this.config.memoryContextLimit}, ` +
          `user_context_limit=${this.config.userContextLimit}, ` +
          `user_context_retention_days=${this.config.userContextRetentionDays}, ` +
          `evolution_enabled=${this.config.evolutionEnabled ? "on" : "off"}, ` +
          `evolution_interval_minutes=${this.config.evolutionIntervalMinutes}, ` +
          `require_trigger=${this.config.requireTrigger ? "on" : "off"}, ` +
          `allow_local_path_repo=${this.config.allowLocalPathRepo ? "on" : "off"}, ` +
          `auto_stash_before_apply=${this.config.autoStashBeforeApply ? "on" : "off"}, ` +
          `plan_approval=${this.config.planApprovalRequired ? "on" : "off"})`,
        flags: 64
      });
      return;
    }

    if (slashCommand === "task") {
      const repoResolution = this.resolveRepoIdInput(String(args.repo ?? ""));
      if (!repoResolution.ok) {
        await interaction.createMessage({ content: repoResolution.message, flags: 64 });
        return;
      }
      const task = this.orchestrator.createTask({
        repoId: repoResolution.repoId,
        prompt: String(args.prompt),
        requesterUserId: userId,
        requesterChannelId: channelId,
        baseBranch: args.base_branch ? String(args.base_branch) : undefined,
        testProfile: args.test_profile ? String(args.test_profile) : undefined,
        openVsCode: Boolean(args.open_vscode ?? false)
      });
      await interaction.createMessage({ content: `Task accepted: ${task.taskId}`, flags: 64 });
      return;
    }

    if (slashCommand === "status") {
      const data = this.orchestrator.getStatus(String(args.task_id));
      await interaction.createMessage({
        content: `Task ${data.task.taskId} status=${data.task.status}`,
        flags: 64
      });
      return;
    }

    if (slashCommand === "approve") {
      void this.orchestrator.approveTask(String(args.task_id), userId).catch((err) => {
        this.logger.error(`Approve failed for ${String(args.task_id)}: ${(err as Error).message}`);
        void this.bot.createMessage(channelId, {
          content: `**[${String(args.task_id)}] ERROR** ${redactText((err as Error).message)}`
        });
      });
      await interaction.createMessage({
        content: `Approved ${args.task_id}, execution started in background.`,
        flags: 64
      });
      return;
    }

    if (slashCommand === "reject") {
      this.orchestrator.rejectTask(String(args.task_id), userId, args.reason ? String(args.reason) : undefined);
      await interaction.createMessage({ content: `Rejected ${args.task_id}`, flags: 64 });
      return;
    }

    if (slashCommand === "cancel") {
      this.orchestrator.cancelTask(String(args.task_id), userId);
      await interaction.createMessage({ content: `Cancelled ${args.task_id}`, flags: 64 });
      return;
    }

    if (slashCommand === "open") {
      await this.orchestrator.openInVSCode(String(args.task_id));
      await interaction.createMessage({ content: `Opened ${args.task_id} in VS Code`, flags: 64 });
      return;
    }

    if (slashCommand === "run") {
      const result = await this.orchestrator.runCommand(
        String(args.task_id),
        userId,
        channelId,
        String(args.cmd)
      );

      if (result.type === "needs_confirmation") {
        await interaction.createMessage({
          content: `Danger command queued for confirmation (token=${result.token}).`,
          flags: 64
        });
        return;
      }

      await interaction.createMessage({
        content: `Run done. exit=${result.result.exitCode}`,
        flags: 64
      });
      return;
    }

    if (slashCommand === "read") {
      const content = this.readLocalFileReply(
        String(args.path ?? ""),
        args.repo ? String(args.repo) : undefined,
        args.start_line,
        args.end_line,
        args.max_chars
      );
      await interaction.createMessage({ content, flags: 64 });
      return;
    }

    if (slashCommand === "repos") {
      const repos = this.orchestrator.listRepos();
      const lines = repos.map((r) => `- ${r.id} (${r.defaultBaseBranch})`).join("\n");
      await interaction.createMessage({ content: lines || "No repos", flags: 64 });
      return;
    }

    if (slashCommand === "provider") {
      const modeRaw = String(args.mode ?? "").trim().toLowerCase();
      if (!modeRaw) {
        const state = this.orchestrator.getPatchProviderState();
        await interaction.createMessage({
          content:
            `patch_provider=${state.active}\n` +
            `display=${state.displayName}\n` +
            `available=${state.available.join(",")}`,
          flags: 64
        });
        return;
      }

      if (!["auto", "codex", "gemini"].includes(modeRaw)) {
        await interaction.createMessage({ content: "mode 仅支持 auto/codex/gemini", flags: 64 });
        return;
      }

      const state = this.orchestrator.setPatchProvider(modeRaw as "auto" | "codex" | "gemini");
      await interaction.createMessage({
        content:
          `已切换 patch_provider=${state.active}\n` +
          `display=${state.displayName}\n` +
          `available=${state.available.join(",")}`,
        flags: 64
      });
      return;
    }

    await interaction.createMessage({ content: "Unsupported NL command", flags: 64 });
  }
}
