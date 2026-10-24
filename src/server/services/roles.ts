import { DUTIES, type Duty, type RoleRow } from '@shared/types'
import { DUTY_PERMISSION, PERMISSIONS, type Permission } from '@shared/permissions'
import type { Ctx } from '../context'
import type { DB } from '../db/connection'
import { AppError, assert } from '../errors'
import { audit } from './audit'

export const ADMIN_ROLE = 'Organization Admin'
export const WORKER_ROLE = 'Farm Worker'
/** What a data-entry user could do before roles existed (all duties). */
const WORKER_PERMISSIONS = DUTIES.map((d) => DUTY_PERMISSION[d])

/** The user's permissions are their role's; an administrator role has every permission. */
export function hasPermission(user: { permissions: string[] } | null | undefined, p: Permission): boolean {
  return !!user && user.permissions.includes(p)
}

export function requirePermission(ctx: Pick<Ctx, 'user'>, p: Permission) {
  if (!ctx.user) throw new AppError('not_logged_in')
  if (!hasPermission(ctx.user, p)) throw new AppError('no_permission')
  return ctx.user
}

/** The permissions of a role (every permission for the administrator role). */
export async function rolePermissions(db: DB, orgId: number, roleId: number | null): Promise<{ isAdmin: boolean; name: string | null; permissions: Permission[] }> {
  if (!roleId) return { isAdmin: false, name: null, permissions: [] }
  const role = (await db.prepare('SELECT name, is_admin FROM roles WHERE id = ? AND organization_id = ? AND archived_at IS NULL').get(roleId, orgId)) as
    | { name: string; is_admin: number }
    | undefined
  if (!role) return { isAdmin: false, name: null, permissions: [] }
  if (role.is_admin) return { isAdmin: true, name: role.name, permissions: [...PERMISSIONS] }
  const rows = (await db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? AND organization_id = ?').all(roleId, orgId)) as { permission: string }[]
  const known = new Set<string>(PERMISSIONS)
  return { isAdmin: false, name: role.name, permissions: rows.map((r) => r.permission).filter((p): p is Permission => known.has(p)) }
}

/** The duties shown under "My duties today", from the permissions. */
export function dutiesOf(permissions: string[]): Duty[] {
  return DUTIES.filter((d) => permissions.includes(DUTY_PERMISSION[d]))
}

async function insertRole(db: DB, orgId: number, r: { name: string; description: string | null; isAdmin: boolean; permissions: readonly string[] }) {
  const id = (
    await db
      .prepare('INSERT INTO roles (organization_id, name, description, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(orgId, r.name, r.description, r.isAdmin ? 1 : 0, new Date().toISOString())
  ).lastInsertRowid
  if (!r.isAdmin && r.permissions.length) {
    await db.query('INSERT INTO role_permissions (organization_id, role_id, permission) VALUES ?', [r.permissions.map((p) => [orgId, id, p])])
  }
  return id
}

/**
 * Makes sure the organization has its administrator and data-entry roles, and gives every
 * account without a role one that matches what it could do before roles existed:
 * administrators → Organization Admin; data-entry users → Farm Worker, or a role with exactly
 * their duties if those were limited. Used by the upgrade to roles, by restores and imports of
 * older backups, and when an organization is created.
 */
export async function ensureRoles(db: DB, orgId: number) {
  const find = async (where: string, ...args: unknown[]) =>
    ((await db.prepare(`SELECT id FROM roles WHERE organization_id = ? AND ${where} ORDER BY id LIMIT 1`).get(orgId, ...args)) as { id: number } | undefined)?.id
  const adminRole = (await find('is_admin = 1')) ?? (await insertRole(db, orgId, { name: ADMIN_ROLE, description: null, isAdmin: true, permissions: [] }))
  let workerRole = await find('name = ?', WORKER_ROLE)
  const users = (await db.prepare('SELECT id, role, duties, display_name FROM users WHERE organization_id = ? AND role_id IS NULL').all(orgId)) as {
    id: number
    role: string | null
    duties: string | null
    display_name: string
  }[]
  workerRole ??= await insertRole(db, orgId, { name: WORKER_ROLE, description: null, isAdmin: false, permissions: WORKER_PERMISSIONS })
  for (const u of users) {
    let roleId = u.role === 'admin' ? adminRole : workerRole
    if (u.role !== 'admin' && u.duties) {
      let duties: Duty[] = []
      try {
        duties = (JSON.parse(u.duties) as string[]).filter((d): d is Duty => (DUTIES as readonly string[]).includes(d))
      } catch {
        duties = [...DUTIES]
      }
      if (duties.length !== DUTIES.length) {
        let name = `${u.display_name} (duties)`.slice(0, 100)
        for (let n = 2; await find('name = ?', name); n++) name = `${u.display_name} (duties ${n})`.slice(0, 100)
        roleId = await insertRole(db, orgId, { name, description: null, isAdmin: false, permissions: duties.map((d) => DUTY_PERMISSION[d]) })
      }
    }
    await db.prepare("UPDATE users SET role_id = ?, role = ? WHERE id = ?").run(roleId, roleId === adminRole ? 'admin' : 'operator', u.id)
  }
}

export async function listRoles(ctx: Pick<Ctx, 'db' | 'org'>): Promise<RoleRow[]> {
  const roles = (await ctx.db
    .prepare(
      `SELECT r.id, r.name, r.description, r.is_admin, r.archived_at,
         (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.active = 1 AND u.pending = 0) AS users
       FROM roles r WHERE r.organization_id = ? ORDER BY r.is_admin DESC, r.archived_at IS NOT NULL, r.name`
    )
    .all(ctx.org)) as { id: number; name: string; description: string | null; is_admin: number; archived_at: string | null; users: number }[]
  const perms = (await ctx.db.prepare('SELECT role_id, permission FROM role_permissions WHERE organization_id = ?').all(ctx.org)) as { role_id: number; permission: string }[]
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isAdmin: !!r.is_admin,
    permissions: r.is_admin ? [...PERMISSIONS] : perms.filter((p) => p.role_id === r.id).map((p) => p.permission),
    users: r.users,
    archived: !!r.archived_at
  }))
}

/** An active role of the context's organization; any other id is "not found". */
export async function getRole(ctx: Pick<Ctx, 'db' | 'org'>, id: number) {
  const r = (await ctx.db.prepare('SELECT id, name, is_admin FROM roles WHERE id = ? AND organization_id = ? AND archived_at IS NULL').get(id, ctx.org)) as
    | { id: number; name: string; is_admin: number }
    | undefined
  assert(r, 'role_not_found')
  return r
}

/**
 * Creates or changes a role. Only permissions the signed-in user holds can be given, so nobody can
 * create a role more powerful than their own. The administrator role cannot be changed.
 */
export async function saveRole(ctx: Ctx, r: { id: number | null; name: string; description: string | null; permissions: string[] }): Promise<number> {
  const user = ctx.user!
  const name = r.name.trim()
  assert(name.length >= 2, 'required_field', { field: 'name' })
  const known = new Set<string>(PERMISSIONS)
  const permissions = [...new Set(r.permissions)].filter((p) => known.has(p))
  for (const p of permissions) if (!user.permissions.includes(p)) throw new AppError('cannot_grant_permission', { permission: p })
  return ctx.db.transaction(async () => {
    const dup = await ctx.db.prepare('SELECT 1 AS x FROM roles WHERE organization_id = ? AND name = ? AND NOT (id <=> ?)').get(ctx.org, name, r.id)
    assert(!dup, 'name_taken')
    let id = r.id
    let before: string[] = []
    if (id) {
      const role = await getRole(ctx, id)
      assert(!role.is_admin, 'admin_role_locked')
      before = (await listRoles(ctx)).find((x) => x.id === id)!.permissions
      // A user cannot take away permissions they do not hold themselves either.
      for (const p of before) if (!permissions.includes(p) && !user.permissions.includes(p)) throw new AppError('cannot_grant_permission', { permission: p })
      await ctx.db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?').run(name, r.description?.trim() || null, id)
      await ctx.db.prepare('DELETE FROM role_permissions WHERE role_id = ? AND organization_id = ?').run(id, ctx.org)
      if (permissions.length) await ctx.db.query('INSERT INTO role_permissions (organization_id, role_id, permission) VALUES ?', [permissions.map((p) => [ctx.org, id, p])])
    } else {
      id = await insertRole(ctx.db, ctx.org, { name, description: r.description?.trim() || null, isAdmin: false, permissions })
    }
    await audit(ctx, { action: r.id ? 'update' : 'create', entity: 'role', entityId: id, details: { name, before: r.id ? before : undefined, after: permissions } })
    return id
  })()
}

/** Archives a role nobody uses; its history stays. The administrator role cannot be archived. */
export async function archiveRole(ctx: Ctx, id: number) {
  await ctx.db.transaction(async () => {
    const role = await getRole(ctx, id)
    assert(!role.is_admin, 'admin_role_locked')
    const used = (await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role_id = ? AND active = 1').get(ctx.org, id)) as { n: number }
    assert(used.n === 0, 'role_in_use', { count: used.n })
    await ctx.db.prepare('UPDATE roles SET archived_at = ? WHERE id = ?').run(ctx.now().toISOString(), id)
    await audit(ctx, { action: 'archive', entity: 'role', entityId: id, details: { name: role.name } })
  })()
}

/**
 * A role may only be given by someone who holds all of its permissions, and an account more
 * powerful than one's own cannot be changed: nobody can raise themselves or anyone else above
 * their own level (e.g. a user manager making someone an administrator).
 */
export async function assertCanAssignRole(ctx: Ctx, roleId: number) {
  await getRole(ctx, roleId)
  const target = await rolePermissions(ctx.db, ctx.org, roleId)
  for (const p of target.permissions) if (!ctx.user!.permissions.includes(p)) throw new AppError('cannot_grant_permission', { permission: p })
}

export async function assertCanManageUser(ctx: Ctx, userId: number) {
  const row = (await ctx.db.prepare('SELECT role_id FROM users WHERE id = ? AND organization_id = ?').get(userId, ctx.org)) as { role_id: number | null } | undefined
  assert(row, 'not_found')
  const target = await rolePermissions(ctx.db, ctx.org, row.role_id)
  for (const p of target.permissions) if (!ctx.user!.permissions.includes(p)) throw new AppError('no_permission')
}
