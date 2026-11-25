// Small JSON HTTP client with timeout and retry/backoff, used by chain adapters.
// `fetch` is injectable so tests can replay recorded responses (fixtures).

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff (ms). */
  backoffMs?: number;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export class JsonHttpClient {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly headers: Record<string, string>;

  constructor(options: HttpOptions = {}) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.retries = options.retries ?? 3;
    this.backoffMs = options.backoffMs ?? 500;
    this.headers = options.headers ?? {};
  }

  get<T>(url: string): Promise<T> {
    return this.request<T>(url, { method: 'GET' });
  }

  post<T>(url: string, body: unknown): Promise<T> {
    return this.request<T>(url, { method: 'POST', body: JSON.stringify(body) });
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      try {
        const response = await this.fetchFn(url, {
          ...init,
          headers: { 'content-type': 'application/json', accept: 'application/json', ...this.headers },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new HttpError(`HTTP ${response.status} from ${redact(url)}`, response.status);
          continue; // rate limited or server error: retry with backoff
        }
        if (!response.ok) {
          throw new HttpError(`HTTP ${response.status} from ${redact(url)}`, response.status);
        }
        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof HttpError && error.status !== null && error.status < 500 && error.status !== 429) {
          throw error; // client errors are not retried
        }
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Never log API keys that some providers put in the URL path or query. */
export function redact(url: string): string {
  return url.replace(/(\/v2\/|\/v3\/|apikey=|api_key=|key=)[A-Za-z0-9_-]{8,}/gi, '$1***');
}
