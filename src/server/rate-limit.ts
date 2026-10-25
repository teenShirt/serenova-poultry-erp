/**
 * Limits how often one address may try to sign in, sign up or reset a password (on top of the
 * per-account lockout after five wrong passwords). Counted per minute, in memory.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>()
  /** Refusals, for the security events shown in the platform console. */
  readonly refused: { at: string; key: string }[] = []

  constructor(
    private readonly perMinute: number,
    private readonly now = () => Date.now()
  ) {}

  /** Seconds to wait when over the limit, else 0 (and the attempt is counted). */
  hit(key: string): number {
    const t = this.now()
    const w = this.windows.get(key)
    if (!w || t - w.start >= 60_000) {
      this.windows.set(key, { start: t, count: 1 })
      if (this.windows.size > 10_000) this.prune(t)
      return 0
    }
    w.count++
    if (w.count <= this.perMinute) return 0
    this.refused.unshift({ at: new Date(t).toISOString(), key: key.replace(/:[^:]*$/, '') })
    this.refused.length = Math.min(this.refused.length, 100)
    return Math.ceil((w.start + 60_000 - t) / 1000)
  }

  private prune(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= 60_000) this.windows.delete(k)
  }
}
