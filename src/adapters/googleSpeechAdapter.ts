import { Logger } from "../logger";
import { requestBuffer, requestJson } from "../utils/http";

interface SpeechApiResponse {
  results?: Array<{
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  }>;
  error?: {
    code?: number;
    message?: string;
  };
}

export interface GoogleSpeechOptions {
  apiKey: string;
  languageCode: string;
  timeoutMs: number;
  proxyUrl?: string | null;
}

export class GoogleSpeechAdapter {
  constructor(private readonly options: GoogleSpeechOptions, private readonly logger: Logger) {}

  public isAudioAttachment(attachment: any): boolean {
    const contentType = String(attachment?.content_type ?? attachment?.contentType ?? "").toLowerCase();
    const fileName = String(attachment?.filename ?? "").toLowerCase();
    if (contentType.startsWith("audio/")) {
      return true;
    }
    return /\.(ogg|mp3|wav|webm|m4a|flac)$/i.test(fileName);
  }

  public async transcribeAttachment(url: string, contentType?: string | null): Promise<string> {
    const audioResponse = await requestBuffer({
      method: "GET",
      url,
      timeoutMs: this.options.timeoutMs,
      proxyUrl: this.options.proxyUrl
    });

    if (audioResponse.statusCode < 200 || audioResponse.statusCode >= 300) {
      throw new Error(`Failed to fetch audio: HTTP ${audioResponse.statusCode}`);
    }

    const config = this.buildConfig(contentType);
    const payload = {
      config,
      audio: {
        content: audioResponse.body.toString("base64")
      }
    };

    const response = await requestJson<SpeechApiResponse>({
      method: "POST",
      url: `https://speech.googleapis.com/v1/speech:recognize?key=${encodeURIComponent(this.options.apiKey)}`,
      headers: {
        "Content-Type": "application/json"
      },
      body: Buffer.from(JSON.stringify(payload), "utf8"),
      timeoutMs: this.options.timeoutMs,
      proxyUrl: this.options.proxyUrl
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const apiMessage = response.json?.error?.message ?? "unknown error";
      throw new Error(`Google Speech API error: HTTP ${response.statusCode} ${apiMessage}`);
    }

    const transcripts = (response.json.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript?.trim() ?? "")
      .filter(Boolean);

    const transcript = transcripts.join(" ").trim();
    this.logger.info(`Voice transcript length=${transcript.length}`);
    return transcript;
  }

  private buildConfig(contentType?: string | null): Record<string, unknown> {
    const mime = String(contentType ?? "").toLowerCase();
    const config: Record<string, unknown> = {
      languageCode: this.options.languageCode || "zh-CN",
      enableAutomaticPunctuation: true,
      model: "latest_short"
    };

    if (mime.includes("ogg")) {
      config.encoding = "OGG_OPUS";
      config.sampleRateHertz = 48000;
    } else if (mime.includes("webm")) {
      config.encoding = "WEBM_OPUS";
      config.sampleRateHertz = 48000;
    } else if (mime.includes("wav")) {
      config.encoding = "LINEAR16";
    } else if (mime.includes("mpeg") || mime.includes("mp3")) {
      config.encoding = "MP3";
    } else if (mime.includes("flac")) {
      config.encoding = "FLAC";
    }

    return config;
  }
}