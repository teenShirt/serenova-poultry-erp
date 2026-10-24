/**
 * Errors the user can act on. `code` is translated in the UI (errors.<code>);
 * `params` fill placeholders in the translated message.
 */
export class AppError extends Error {
  constructor(
    public code: string,
    public params: Record<string, string | number> = {}
  ) {
    super(code)
  }
}

export function assert(cond: unknown, code: string, params?: Record<string, string | number>): asserts cond {
  if (!cond) throw new AppError(code, params)
}
