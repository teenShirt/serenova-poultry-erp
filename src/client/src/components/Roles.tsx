import { useState } from 'react'
import { Archive, Lock, Pencil, Plus, ShieldCheck } from 'lucide-react'
import { PERMISSION_GROUPS, ROLE_TEMPLATES, type Permission } from '@shared/permissions'
import type { RoleRow } from '@shared/types'
import { call } from '../lib/api'
import { useApp, useLoad } from '../lib/app'
import { Card, ConfirmDialog, Field, Modal, Notice } from './ui'

/** The organization's roles: what each kind of user may do. */
export function RolesCard() {
  const { t, num } = useApp()
  const { data: roles, reload } = useLoad(() => call('roles.list'), [])
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null)
  const [archiving, setArchiving] = useState<RoleRow | null>(null)
  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8 }}>
          <ShieldCheck size={20} color="var(--brand)" /> {t('role.title')}
        </h2>
      }
      actions={
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={18} /> {t('role.add')}
        </button>
      }
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{t('role.name')}</th>
              <th>{t('role.permissions')}</th>
              <th className="num">{t('role.users')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(roles ?? []).map((r) => (
              <tr key={r.id} className={r.archived ? 'muted' : undefined}>
                <td>
                  <strong>{r.name}</strong>
                  {r.archived && (
                    <span className="badge" style={{ marginLeft: 6 }}>
                      {t('role.archived')}
                    </span>
                  )}
                  {r.description && <div className="small muted">{r.description}</div>}
                </td>
                <td className="small">
                  {r.isAdmin ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Lock size={14} /> {t('role.adminHint')}
                    </span>
                  ) : (
                    r.permissions.map((p) => t('perm.' + p)).join(', ') || t('common.none')
                  )}
                </td>
                <td className="num">{num(r.users)}</td>
                <td className="nowrap right">
                  {!r.isAdmin && !r.archived && (
                    <>
                      <button className="icon-btn" title={t('common.edit')} onClick={() => setEditing(r)}>
                        <Pencil size={16} />
                      </button>
                      <button className="icon-btn" title={t('role.archive')} onClick={() => setArchiving(r)}>
                        <Archive size={16} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <RoleForm
          role={editing === 'new' ? null : editing}
          onClose={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
      {archiving && (
        <ConfirmDialog
          title={`${t('role.archive')} — ${archiving.name}`}
          body={t('role.archiveHint')}
          danger
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            await call('roles.archive', { id: archiving.id })
            reload()
          }}
        />
      )}
    </Card>
  )
}

function RoleForm({ role, onClose }: { role: RoleRow | null; onClose: () => void }) {
  const { t, toast, fail, can } = useApp()
  const [name, setName] = useState(role?.name ?? '')
  const [description, setDescription] = useState(role?.description ?? '')
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? [])
  const [busy, setBusy] = useState(false)
  const toggle = (p: Permission) => setPerms(perms.includes(p) ? perms.filter((x) => x !== p) : [...perms, p])
  const fromTemplate = (key: string) => {
    const tpl = ROLE_TEMPLATES.find((x) => x.key === key)
    if (!tpl) return
    // Only what the signed-in user may give themselves.
    setPerms(tpl.permissions.filter((p) => can(p)))
    if (!name.trim()) setName(t('roletpl.' + key))
  }
  return (
    <Modal
      wide
      title={role ? `${t('common.edit')} — ${role.name}` : t('role.add')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              setBusy(true)
              try {
                await call('roles.save', { id: role?.id ?? null, name: name.trim(), description: description.trim() || null, permissions: perms })
                toast('success', t('common.saved'))
                onClose()
              } catch (e) {
                fail(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="form-grid">
          <Field label={t('role.name')} required>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          {!role && (
            <Field label={t('role.template')}>
              <select className="select" defaultValue="" onChange={(e) => fromTemplate(e.target.value)}>
                <option value="">{t('role.templateNone')}</option>
                {ROLE_TEMPLATES.map((x) => (
                  <option key={x.key} value={x.key}>
                    {t('roletpl.' + x.key)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('role.description')}>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <Notice tone="info">{t('role.cannotGrantHint')}</Notice>
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.key}>
            <h3 style={{ marginBottom: 8 }}>{t('permg.' + g.key)}</h3>
            <div className="duty-grid">
              {g.permissions.map((p) => {
                const allowed = can(p)
                return (
                  <label
                    key={p}
                    className={`duty ${perms.includes(p) ? 'done' : ''}`}
                    style={{ cursor: allowed ? 'pointer' : 'not-allowed', opacity: allowed ? 1 : 0.55 }}
                  >
                    <span className="check">
                      <input type="checkbox" checked={perms.includes(p)} disabled={!allowed} onChange={() => toggle(p)} />
                      <strong>{t('perm.' + p)}</strong>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
