# Runbook: high API error rate

**Alerts:** `PfmErrorBudgetFastBurn` (page), `PfmErrorBudgetSlowBurn` (ticket)
**Impact:** farm staff see failed saves or errors on screen.

## 1. Confirm (2 minutes)

- Grafana → *Poultry Farm Manager — SLOs* → "5xx error ratio" and "Requests per second by route".
- Which route? `sum by (route,status) (rate(pfm_http_requests_total{status=~"5.."}[5m]))`

## 2. Did something just change?

```bash
kubectl -n argocd get application poultry -o jsonpath='{.status.sync.revision}{"\n"}'
kubectl -n poultry rollout history deployment/poultry
```

If errors started with a release, **roll back first, investigate second**:

```bash
git revert <tag-commit> && git push      # GitOps: Argo CD rolls back to the previous image
# Emergency only (Argo CD will re-sync from git afterwards):
kubectl -n poultry rollout undo deployment/poultry
```

## 3. Not a release? Check dependencies

```bash
kubectl -n poultry get pods -o wide
kubectl -n poultry logs deploy/poultry --since=15m | grep -iE "error|DATABASE_BUSY|ECONN"
kubectl -n poultry exec sts/poultry-mysql -- mysqladmin -uroot -p"$MYSQL_ROOT_PASSWORD" status
```

- `DATABASE_BUSY`: write-lock contention. Look for a long-running backup or restore; see
  [slow-responses](slow-responses.md).
- Connection errors: follow [app-not-ready](app-not-ready.md).

## 4. Close out

- The burn rate is back under 1×. Note the budget used in the incident channel.
- Paged? Write a [postmortem](../postmortem-template.md).
