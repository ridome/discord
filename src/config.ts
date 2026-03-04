import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { z } from "zod";
import { RepoConfig } from "./types";

const repoSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  defaultBaseBranch: z.string().min(1),
  testProfiles: z.record(z.array(z.string().min(1))).default({})
});

const repoFileSchema = z.object({
  repos: z.array(repoSchema)
});

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_PROXY_URL: z.string().optional(),
  CODEX_EXECUTABLE: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  GEMINI_API_BASE_URL: z.string().default("https://generativelanguage.googleapis.com/v1beta"),
  GEMINI_TIMEOUT_MS: z.string().default("20000"),
  GEMINI_FIRST: z.string().default("true"),
  GEMINI_STRICT_MODEL: z.string().default("true"),
  MEMORY_GEMINI_AUTO: z.string().default("true"),
  MEMORY_CONTEXT_LIMIT: z.string().default("8"),
  USER_CONTEXT_LIMIT: z.string().default("12"),
  USER_CONTEXT_RETENTION_DAYS: z.string().default("14"),
  EVOLUTION_ENABLED: z.string().default("true"),
  EVOLUTION_INTERVAL_MINUTES: z.string().default("45"),
  EVOLUTION_FAILURE_CONTEXT_LIMIT: z.string().default("12"),
  EVOLUTION_MEMORY_LIMIT: z.string().default("12"),
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_SPEECH_LANGUAGE_CODE: z.string().default("zh-CN"),
  GOOGLE_SPEECH_TIMEOUT_MS: z.string().default("20000"),
  ALLOWED_USER_IDS: z.string().min(1),
  ALLOWED_CHANNEL_IDS: z.string().min(1),
  ALLOWED_ROLE_IDS: z.string().default(""),
  BOT_PREFIX: z.string().default("!codex"),
  REQUIRE_TRIGGER: z.string().default("false"),
  ALLOW_LOCAL_PATH_REPO: z.string().default("true"),
  PLAN_APPROVAL_REQUIRED: z.string().default("true"),
  AUTO_STASH_BEFORE_APPLY: z.string().default("true"),
  TASK_TIMEOUT_MINUTES: z.string().default("25"),
  LOG_RETENTION_DAYS: z.string().default("30"),
  STREAM_THROTTLE_SECONDS: z.string().default("3"),
  REPO_CONFIG_PATH: z.string().default("./config/repos.json"),
  DB_PATH: z.string().default("./data/state.db"),
  REGISTER_COMMANDS: z.string().default("true")
});

export interface AppConfig {
  discordBotToken: string;
  discordAppId: string;
  discordProxyUrl: string | null;
  codexExecutable: string | null;
  geminiApiKey: string | null;
  geminiModel: string;
  geminiApiBaseUrl: string;
  geminiTimeoutMs: number;
  geminiFirst: boolean;
  geminiStrictModel: boolean;
  memoryGeminiAuto: boolean;
  memoryContextLimit: number;
  userContextLimit: number;
  userContextRetentionDays: number;
  evolutionEnabled: boolean;
  evolutionIntervalMinutes: number;
  evolutionFailureContextLimit: number;
  evolutionMemoryLimit: number;
  googleApiKey: string | null;
  googleSpeechLanguageCode: string;
  googleSpeechTimeoutMs: number;
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  allowedRoleIds: Set<string>;
  botPrefix: string;
  requireTrigger: boolean;
  allowLocalPathRepo: boolean;
  planApprovalRequired: boolean;
  autoStashBeforeApply: boolean;
  taskTimeoutMinutes: number;
  logRetentionDays: number;
  streamThrottleSeconds: number;
  repoConfigPath: string;
  dbPath: string;
  registerCommands: boolean;
  repos: RepoConfig[];
  reposById: Map<string, RepoConfig>;
}

function splitIds(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function loadRepoConfig(repoConfigPath: string): RepoConfig[] {
  if (!fs.existsSync(repoConfigPath)) {
    throw new Error(
      `Repo config not found at ${repoConfigPath}. Copy config/repos.example.json to config/repos.json and update it.`
    );
  }

  const raw = fs.readFileSync(repoConfigPath, "utf8");
  const parsed = repoFileSchema.parse(JSON.parse(raw));

  return parsed.repos.map((repo) => ({
    ...repo,
    path: path.resolve(repo.path)
  }));
}

export function loadConfig(): AppConfig {
  dotenv.config();
  const env = envSchema.parse(process.env);
  const repoConfigPath = path.resolve(env.REPO_CONFIG_PATH);
  const repos = loadRepoConfig(repoConfigPath);
  const reposById = new Map(repos.map((r) => [r.id, r]));

  return {
    discordBotToken: env.DISCORD_BOT_TOKEN,
    discordAppId: env.DISCORD_APP_ID,
    discordProxyUrl: env.DISCORD_PROXY_URL && env.DISCORD_PROXY_URL.trim().length > 0
      ? env.DISCORD_PROXY_URL.trim()
      : null,
    codexExecutable: env.CODEX_EXECUTABLE && env.CODEX_EXECUTABLE.trim().length > 0
      ? env.CODEX_EXECUTABLE.trim()
      : null,
    geminiApiKey: env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim().length > 0
      ? env.GEMINI_API_KEY.trim()
      : null,
    geminiModel: env.GEMINI_MODEL,
    geminiApiBaseUrl: env.GEMINI_API_BASE_URL,
    geminiTimeoutMs: Number(env.GEMINI_TIMEOUT_MS),
    geminiFirst: env.GEMINI_FIRST.toLowerCase() === "true",
    geminiStrictModel: env.GEMINI_STRICT_MODEL.toLowerCase() === "true",
    memoryGeminiAuto: env.MEMORY_GEMINI_AUTO.toLowerCase() === "true",
    memoryContextLimit: Number(env.MEMORY_CONTEXT_LIMIT),
    userContextLimit: Number(env.USER_CONTEXT_LIMIT),
    userContextRetentionDays: Number(env.USER_CONTEXT_RETENTION_DAYS),
    evolutionEnabled: env.EVOLUTION_ENABLED.toLowerCase() === "true",
    evolutionIntervalMinutes: Number(env.EVOLUTION_INTERVAL_MINUTES),
    evolutionFailureContextLimit: Number(env.EVOLUTION_FAILURE_CONTEXT_LIMIT),
    evolutionMemoryLimit: Number(env.EVOLUTION_MEMORY_LIMIT),
    googleApiKey: env.GOOGLE_API_KEY && env.GOOGLE_API_KEY.trim().length > 0
      ? env.GOOGLE_API_KEY.trim()
      : null,
    googleSpeechLanguageCode: env.GOOGLE_SPEECH_LANGUAGE_CODE,
    googleSpeechTimeoutMs: Number(env.GOOGLE_SPEECH_TIMEOUT_MS),
    allowedUserIds: splitIds(env.ALLOWED_USER_IDS),
    allowedChannelIds: splitIds(env.ALLOWED_CHANNEL_IDS),
    allowedRoleIds: splitIds(env.ALLOWED_ROLE_IDS),
    botPrefix: env.BOT_PREFIX,
    requireTrigger: env.REQUIRE_TRIGGER.toLowerCase() === "true",
    allowLocalPathRepo: env.ALLOW_LOCAL_PATH_REPO.toLowerCase() === "true",
    planApprovalRequired: env.PLAN_APPROVAL_REQUIRED.toLowerCase() === "true",
    autoStashBeforeApply: env.AUTO_STASH_BEFORE_APPLY.toLowerCase() === "true",
    taskTimeoutMinutes: Number(env.TASK_TIMEOUT_MINUTES),
    logRetentionDays: Number(env.LOG_RETENTION_DAYS),
    streamThrottleSeconds: Number(env.STREAM_THROTTLE_SECONDS),
    repoConfigPath,
    dbPath: path.resolve(env.DB_PATH),
    registerCommands: env.REGISTER_COMMANDS.toLowerCase() === "true",
    repos,
    reposById
  };
}
