/**
 * The queue needs to know whether trying again can help.
 * Transient: network, timeouts, 429, 5xx. Wait and retry.
 * Permanent: bad token, missing list, invalid request. Retrying only burns
 * attempts, so the message goes straight to the failure queue for a person.
 */
export class TransientError extends Error {
  readonly kind = "transient";
}

export class PermanentError extends Error {
  readonly kind = "permanent";
}

export function isPermanent(error: unknown): boolean {
  return error instanceof PermanentError;
}

/** Turns an HTTP failure from an external API into the right kind of error. */
export function httpError(service: string, status: number, detail: string): Error {
  const message = `${service} respondeu ${status}: ${detail.slice(0, 160)}`;
  return status === 429 || status >= 500 ? new TransientError(message) : new PermanentError(message);
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
