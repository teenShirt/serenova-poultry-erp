import type { TestProject } from 'vitest/node'

export interface TestMysql {
  host: string
  port: number
  user: string
  password: string
}

declare module 'vitest' {
  export interface ProvidedContext {
    mysql: TestMysql
  }
}

/**
 * The tests need a MySQL 8 server. Set TEST_DB_HOST (and TEST_DB_PORT, TEST_DB_USER,
 * TEST_DB_PASSWORD) to use an existing one; otherwise a throw-away server is downloaded
 * (once, then cached) and started for the test run. Each test creates its own database.
 */
export default async function setup(project: TestProject) {
  if (process.env['TEST_DB_HOST']) {
    project.provide('mysql', {
      host: process.env['TEST_DB_HOST'],
      port: Number(process.env['TEST_DB_PORT'] ?? 3306),
      user: process.env['TEST_DB_USER'] ?? 'root',
      password: process.env['TEST_DB_PASSWORD'] ?? ''
    })
    return
  }
  const { createDB } = await import('mysql-memory-server')
  const db = await createDB({ version: '8.4.x', logLevel: 'ERROR' })
  project.provide('mysql', { host: '127.0.0.1', port: db.port, user: db.username, password: '' })
  return async () => {
    await db.stop()
  }
}
