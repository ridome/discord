import http from "http";
import https from "https";
import { URL } from "url";

const { HttpsProxyAgent } = require("https-proxy-agent");

export interface HttpRequestOptions {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  timeoutMs?: number;
  proxyUrl?: string | null;
}

export interface HttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export async function requestBuffer(options: HttpRequestOptions): Promise<HttpResponse> {
  const url = new URL(options.url);
  const lib = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: options.method,
        headers: options.headers,
        agent:
          options.proxyUrl && url.protocol === "https:" ? new HttpsProxyAgent(options.proxyUrl) : undefined,
        timeout: options.timeoutMs ?? 20000
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`HTTP timeout: ${options.method} ${options.url}`));
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

export async function requestJson<T = any>(options: HttpRequestOptions): Promise<{ statusCode: number; json: T }> {
  const response = await requestBuffer(options);
  const text = response.body.toString("utf8");
  let parsed: any = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return {
    statusCode: response.statusCode,
    json: parsed as T
  };
}