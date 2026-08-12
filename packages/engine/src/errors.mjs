/**
 * Client-side error helpers (minimal subset, self-contained).
 * `message` is always safe to display to the user.
 */
export class AppError extends Error {
  constructor(status, code, message, { details = null, internal = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.internal = internal;
  }
}

const make = (status, code, fallback) => (message = fallback, opts) =>
  new AppError(status, code, message, opts);

export const providerError = make(502, 'PROVIDER_ERROR', 'The upstream AI provider returned an error.');
export const unavailable = make(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
