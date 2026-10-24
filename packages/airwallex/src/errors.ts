export class AirwallexError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path: string,
    readonly source?: string,
  ) {
    super(`[${status} ${code}] ${message} (${path})`);
    this.name = "AirwallexError";
  }

  /** True when we cannot know whether the server applied the request (timeouts, 5xx, network). */
  get ambiguous(): boolean {
    return this.status === 0 || this.status >= 500;
  }

  get retryable(): boolean {
    return this.status === 429 || this.ambiguous;
  }
}

export function awxError(
  status: number,
  code: string,
  message: string,
  path: string,
  source?: string,
): AirwallexError {
  return new AirwallexError(status, code, message, path, source);
}
