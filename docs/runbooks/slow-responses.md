# Runbook: slow responses or high memory

**Alerts:** `PfmLatencySloBreach`, `PfmHighMemory` (tickets)
**Impact:** screens load slowly; reports or saves take seconds.

## 1. Find the slow route

```promql
histogram_quantile(0.95, sum by (le, route) (rate(pfm_http_request_duration_seconds_bucket[5m])))
```

## 2. Common causes

| Signal | Likely cause | Action |
| --- | --- | --- |
| Slow `/api/call/:method` and `DATABASE_BUSY` in logs | A backup, restore or big import holds the write lock | Wait for it to finish; move scheduled backups to a quiet hour |
| All routes slow, CPU near limit | Not enough replicas | `kubectl -n poultry get hpa`; raise `autoscaling.maxReplicas` |
| Memory climbing until restarts | Large report or export in memory | Check `kubectl -n poultry get pods` restarts; raise the limit in `values.yaml` and open a bug with the route |
| MySQL slow | Disk or buffer pool | `kubectl -n poultry top pod`; check Longhorn volume health; consider larger VM disks via Terraform |

## 3. Close out

Latency ratio back above 95% for an hour. Record the cause in the ticket.
