# Runbook: app not ready

**Alert:** `PfmNotReady` (page)
**Impact:** pods are taken out of traffic; users get "service unavailable".

`/readyz` reports why:

```bash
kubectl -n poultry port-forward deploy/poultry 3000:3000 &
curl -s localhost:3000/readyz
```

| `status` | Meaning | Action |
| --- | --- | --- |
| `database_unavailable` | MySQL down or unreachable | `kubectl -n poultry get pods,pvc`; `kubectl -n poultry describe pod poultry-mysql-0`; check the Longhorn volume and the node it runs on in Proxmox |
| `schema_mismatch` | A release expects a newer schema, or a migration failed | `kubectl -n poultry logs deploy/poultry | grep -i migrat`; roll back the image tag if a migration is broken |

If MySQL data is lost or corrupt, restore from the latest encrypted backup following
[RECOVERY.md](../RECOVERY.md). The weekly restore test shows when the last good restore happened.
