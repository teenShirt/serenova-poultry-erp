/**
 * Failures of the server's background jobs (automatic backups, session clean-up), kept in memory
 * since the server started, for the platform console. Every failure is also written to the log.
 */
const MAX = 50
const failures: { at: string; job: string; message: string }[] = []

export function recordJobFailure(job: string, error: unknown) {
  const message = (error as Error)?.message ?? String(error)
  console.error(`${job} failed:`, error)
  failures.unshift({ at: new Date().toISOString(), job, message: message.slice(0, 500) })
  failures.length = Math.min(failures.length, MAX)
}

export function recentJobFailures() {
  return [...failures]
}
