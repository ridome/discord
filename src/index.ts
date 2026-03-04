import fs from "fs";
import path from "path";
import { loadConfig } from "./config";
import { DiscordGateway } from "./discord/discordGateway";
import { GitEngine } from "./engines/gitEngine";
import { PatchEngine } from "./engines/patchEngine";
import { VSCodeBridge } from "./engines/vscodeBridge";
import { Logger } from "./logger";
import { CodexAdapter } from "./adapters/codexAdapter";
import { GeminiPatchAdapter } from "./adapters/geminiPatchAdapter";
import { GeminiAssistantAdapter } from "./adapters/geminiAssistantAdapter";
import { FallbackPatchGenerator } from "./adapters/fallbackPatchGenerator";
import { PatchGenerator } from "./adapters/patchGenerator";
import { PatchGeneratorRouter } from "./adapters/patchGeneratorRouter";
import { GoogleSpeechAdapter } from "./adapters/googleSpeechAdapter";
import { EvolutionService } from "./autonomy/evolutionService";
import { TaskOrchestrator } from "./orchestrator/taskOrchestrator";
import { AccessControl } from "./security/accessControl";
import { CommandGuard } from "./security/commandGuard";
import { RepoRegistry } from "./security/repoRegistry";
import { StateStore } from "./store/stateStore";

function buildPatchGeneratorRouter(
  config: ReturnType<typeof loadConfig>,
  logger: Logger,
  codexAdapter: CodexAdapter,
  geminiPatchAdapter: GeminiPatchAdapter | null
): PatchGeneratorRouter {
  const autoProvider: PatchGenerator = geminiPatchAdapter
    ? new FallbackPatchGenerator(codexAdapter, geminiPatchAdapter, logger)
    : codexAdapter;

  return new PatchGeneratorRouter(
    {
      codex: codexAdapter,
      gemini: geminiPatchAdapter ?? undefined,
      auto: autoProvider
    },
    config.patchProvider,
    logger
  );
}

function acquireSingleInstanceLock(): void {
  const lockPath = path.resolve("./data/bot.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const isProcessAlive = (pid: number): boolean => {
    if (!Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // ESRCH: no such process
      if (err && err.code === "ESRCH") {
        return false;
      }
      // EPERM and others generally mean process exists but cannot signal
      return true;
    }
  };

  const tryCreateLock = (): void => {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  };

  try {
    tryCreateLock();
  } catch (err: any) {
    if (!(err && err.code === "EEXIST")) {
      throw err;
    }

    const existingPidRaw = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8").trim() : "";
    const existingPid = Number(existingPidRaw);
    if (!isProcessAlive(existingPid)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore and let retry handle error reporting
      }
      tryCreateLock();
    } else {
      throw new Error(
        `Bot is already running (lock=${lockPath}, pid=${existingPidRaw || "unknown"}). ` +
          `Use /ping in Discord to verify, or stop that PID before running npm run dev again.`
      );
    }
  }

  const cleanup = () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}

async function main(): Promise<void> {
  acquireSingleInstanceLock();
  const config = loadConfig();
  const logger = new Logger();

  const stateStore = new StateStore(config.dbPath);
  stateStore.cleanupOldEvents(config.logRetentionDays);
  stateStore.cleanupExpiredConfirmations();
  stateStore.cleanupOldUserContext(config.userContextRetentionDays);

  setInterval(() => {
    stateStore.cleanupOldEvents(config.logRetentionDays);
    stateStore.cleanupExpiredConfirmations();
    stateStore.cleanupOldUserContext(config.userContextRetentionDays);
  }, 6 * 60 * 60 * 1000);

  const accessControl = new AccessControl({
    allowedUserIds: config.allowedUserIds,
    allowedChannelIds: config.allowedChannelIds,
    allowedRoleIds: config.allowedRoleIds
  });

  const repoRegistry = new RepoRegistry(config.repos, {
    allowLocalPathRepo: config.allowLocalPathRepo
  });
  const codexAdapter = new CodexAdapter({
    executable: config.codexExecutable
  });
  const geminiPatchAdapter = config.geminiApiKey
    ? new GeminiPatchAdapter(
        {
          apiKey: config.geminiApiKey,
          model: config.geminiModel,
          apiBaseUrl: config.geminiApiBaseUrl,
          timeoutMs: config.geminiTimeoutMs,
          strictModel: config.geminiStrictModel,
          proxyUrl: config.discordProxyUrl
        },
        logger
      )
    : null;
  const patchGenerator = buildPatchGeneratorRouter(config, logger, codexAdapter, geminiPatchAdapter);
  logger.info(
    `[patch-provider] active=${patchGenerator.getState().active} available=${patchGenerator
      .getState()
      .available.join(",")}`
  );
  const patchEngine = new PatchEngine();
  const gitEngine = new GitEngine({
    commitAuthorName: "discord-codex-bot",
    commitAuthorEmail: "bot@local"
  });
  const commandGuard = new CommandGuard();
  const vscodeBridge = new VSCodeBridge();
  const speechAdapter = config.googleApiKey
    ? new GoogleSpeechAdapter(
        {
          apiKey: config.googleApiKey,
          languageCode: config.googleSpeechLanguageCode,
          timeoutMs: config.googleSpeechTimeoutMs,
          proxyUrl: config.discordProxyUrl
        },
        logger
      )
    : null;
  const geminiAdapter = config.geminiApiKey
    ? new GeminiAssistantAdapter(
        {
          apiKey: config.geminiApiKey,
          model: config.geminiModel,
          apiBaseUrl: config.geminiApiBaseUrl,
          timeoutMs: config.geminiTimeoutMs,
          strictModel: config.geminiStrictModel,
          proxyUrl: config.discordProxyUrl
        },
        logger
      )
    : null;

  const orchestrator = new TaskOrchestrator(
    stateStore,
    repoRegistry,
    patchGenerator,
    patchEngine,
    gitEngine,
    commandGuard,
    vscodeBridge,
    logger,
    {
      planApprovalRequired: config.planApprovalRequired,
      taskTimeoutMinutes: config.taskTimeoutMinutes,
      streamThrottleSeconds: config.streamThrottleSeconds,
      patchRetryCount: 1,
      autoStashBeforeApply: config.autoStashBeforeApply
    }
  );

  const gateway = new DiscordGateway(
    config,
    accessControl,
    orchestrator,
    stateStore,
    logger,
    speechAdapter,
    geminiAdapter
  );

  const evolutionService = new EvolutionService(stateStore, geminiAdapter, logger, {
    enabled: config.evolutionEnabled,
    failureContextLimit: config.evolutionFailureContextLimit,
    memoryLimit: config.evolutionMemoryLimit,
    systemUserId: "__system__",
    systemChannelId: "__system__"
  });
  if (config.evolutionEnabled && geminiAdapter) {
    void evolutionService.runOnce().catch((err) => {
      logger.warn(`[evolution] runOnce failed: ${(err as Error).message}`);
    });
    setInterval(() => {
      void evolutionService.runOnce().catch((err) => {
        logger.warn(`[evolution] periodic run failed: ${(err as Error).message}`);
      });
    }, Math.max(5, config.evolutionIntervalMinutes) * 60 * 1000);
  }

  await gateway.start();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
