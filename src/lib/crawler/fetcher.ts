const USER_AGENT =
  "Mozilla/5.0 (compatible; NaturallyCurious/0.1; personal local reader)";
const DEFAULT_TIMEOUT_MS = 15000;
const HOST_DELAY_MS = 1200;
const MAX_REDIRECTS = 8;

const lastRequestByHost = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

async function politeDelay(host: string): Promise<void> {
  const last = lastRequestByHost.get(host);
  const now = Date.now();
  if (last != null && now - last < HOST_DELAY_MS) {
    await sleep(HOST_DELAY_MS - (now - last));
  }
  lastRequestByHost.set(host, Date.now());
}

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}

export async function fetchText(
  url: string,
  options: {
    timeoutMs?: number;
    etag?: string | null;
    lastModified?: string | null;
  } = {}
): Promise<FetchResult> {
  const host = getHost(url);
  if (!host) throw new Error(`invalid url: ${url}`);
  await politeDelay(host);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.8",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    const text = res.status === 304 ? "" : await res.text();
    return {
      ok: res.ok || res.status === 304,
      status: res.status,
      text,
      contentType: res.headers.get("content-type") ?? "",
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      finalUrl: res.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}
