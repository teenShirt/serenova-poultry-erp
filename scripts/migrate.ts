/**
 * Creates the farm (and demonstration) databases if needed and brings their tables up to date.
 * The server does this on start-up too; this script is for checking a new installation.
 *   npm run migrate
 */
import { loadConfig } from '../src/server/config'
import { Databases } from '../src/server/databases'
import { currentSchemaVersion } from '../src/server/db/migrations'

const dbs = await Databases.open(loadConfig())
const v = await dbs.with('farm', (db) => currentSchemaVersion(db))
console.log(`${dbs.location('farm')}: schema v${v}${dbs.demoAvailable ? ` · demonstration data: ${dbs.location('demo')}` : ''}`)
await dbs.close()
