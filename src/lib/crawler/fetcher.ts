const USER_AGENT =
  "Mozilla/5.0 (compatible; NaturallyCurious/0.1; personal local reader)";
const DEFAULT_TIMEOUT_MS = 15000;
const HOST_DELAY_MS = 1200;
// Phones: a multi-MB page is pure waste — extraction reads at most the first
// few hundred KB. Refuse oversized downloads up front (content-length) and
// truncate whatever slips through with lying/absent headers.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

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

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}

// NOTE: politeness is enforced by HostScheduler (below), not here — callers
// doing bulk crawls must route through it so same-host requests stay spaced.
export async function fetchText(
  url: string,
  options: {
    timeoutMs?: number;
    etag?: string | null;
    lastModified?: string | null;
  } = {}
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept:
      "text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml;q=0.9,*/*;q=0.8",
  };
  if (options.etag) headers["If-None-Match"] = options.etag;
  if (options.lastModified) headers["If-Modified-Since"] = options.lastModified;

  try {
    const res = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status !== 304) {
      const declared = parseInt(res.headers.get("content-length") ?? "", 10);
      if (!Number.isNaN(declared) && declared > MAX_BODY_BYTES) {
        return {
          ok: false,
          status: 413,
          text: "",
          contentType: res.headers.get("content-type") ?? "",
          etag: null,
          lastModified: null,
          finalUrl: res.url || url,
        };
      }
    }
    const text = res.status === 304 ? "" : (await res.text()).slice(0, MAX_BODY_BYTES);
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

class Semaphore {
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
}

// Mercator-style scheduling (Heydon & Najork, 1999): one FIFO queue per host
// so politeness holds *per server*, while up to `maxParallel` distinct hosts
// transfer simultaneously. A politeness sleep therefore overlaps with other
// hosts' work instead of blocking a worker slot doing nothing.
export class HostScheduler {
  private sem: Semaphore;
  private hostChains = new Map<string, Promise<void>>();
  private lastHitByHost = new Map<string, number>();

  constructor(
    private readonly maxParallel: number,
    private readonly hostDelayMs: number = HOST_DELAY_MS
  ) {
    this.sem = new Semaphore(maxParallel);
  }

  async run<T>(url: string, task: () => Promise<T>): Promise<T> {
    const host = getHost(url) ?? "unknown";

    // join the tail of this host's chain
    const prev = this.hostChains.get(host) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    this.hostChains.set(host, prev.then(() => gate));

    try {
      await prev.catch(() => {}); // my turn on this host…
      await this.sem.acquire(); // …and a global worker slot

      const last = this.lastHitByHost.get(host);
      if (last != null) {
        const wait = this.hostDelayMs - (Date.now() - last);
        if (wait > 0) await sleep(wait);
      }
      this.lastHitByHost.set(host, Date.now());

      return await task();
    } finally {
      releaseGate();
      this.sem.release();
      const chain = this.hostChains.get(host);
      if (chain === gate.then(() => undefined)) this.hostChains.delete(host);
    }
  }

  get parallelism(): number {
    return this.maxParallel;
  }
}
