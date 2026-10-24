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
    const server = {
      host: process.env['TEST_DB_HOST'],
      port: Number(process.env['TEST_DB_PORT'] ?? 3306),
      user: process.env['TEST_DB_USER'] ?? 'root',
      password: process.env['TEST_DB_PASSWORD'] ?? ''
    }
    project.provide('mysql', server)
    // An existing server keeps its databases: remove the ones the tests created.
    return async () => {
      const mysql = await import('mysql2/promise')
      const c = await mysql.createConnection(server)
      const [rows] = await c.query(
        String.raw`SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE 'pfm\_test\_%' OR schema_name LIKE 'pfm\_tpl\_%'`
      )
      for (const r of rows as { s: string }[]) await c.query(`DROP DATABASE IF EXISTS \`${r.s}\``)
      await c.end()
    }
  }
  const { createDB } = await import('mysql-memory-server')
  const db = await createDB({ version: '8.4.x', logLevel: 'ERROR' })
  project.provide('mysql', { host: '127.0.0.1', port: db.port, user: db.username, password: '' })
  return async () => {
    await db.stop()
  }
}
