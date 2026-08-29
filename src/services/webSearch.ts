import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, type NativeResult } from "./native";

export type WebSearchMode = "web" | "image";

export type WebSearchResult = {
  url: string;
  title: string;
  snippet?: string;
  displayUrl: string;
  thumbnailUrl?: string;
};

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Web検索中に不明なエラーが発生しました。";
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
    ) {
      return undefined;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function plainText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}

function normalizeResult(value: unknown): WebSearchResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const url = safeHttpUrl(item.url);
  if (!url) return undefined;
  const parsed = new URL(url);
  const title = plainText(item.title, parsed.hostname);
  const displayUrl = plainText(item.displayUrl, `${parsed.hostname}${parsed.pathname}`);
  const thumbnailUrl = safeHttpUrl(item.thumbnailUrl);
  return {
    url,
    title: title || parsed.hostname,
    snippet: plainText(item.snippet) || undefined,
    displayUrl,
    thumbnailUrl,
  };
}

export async function searchWeb(
  query: string,
  mode: WebSearchMode = "web",
): Promise<NativeResult<WebSearchResult[]>> {
  if (!isTauriRuntime()) {
    return {
      data: [],
      available: false,
      error: "Web検索はインストールしたPixVaultアプリで利用できます。",
    };
  }

  try {
    const value = await invoke<unknown>("search_web", { query, mode });
    const results = Array.isArray(value)
      ? value.map(normalizeResult).filter((item): item is WebSearchResult => Boolean(item))
      : [];
    return { data: results, available: true };
  } catch (error) {
    return {
      data: [],
      available: true,
      error: messageFrom(error),
    };
  }
}
