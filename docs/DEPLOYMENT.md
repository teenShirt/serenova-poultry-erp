# Deployment

How a change gets from a commit to the production server. In short: **nothing reaches production
unless it passed CI on `main`, was deployed to staging and passed the smoke tests there, and a
person approved it.**

```
push to test ──► CI ──► merge (fast-forward) test → main ──► CI on main
                                                               │ passed
                                                               ▼
                                     Deploy workflow: build the release (once)
                                                               │
                                                  staging: deploy, health check, smoke test
                                                               │ passed
                                         production: waits for approval ► deploy, health check,
                                                                          smoke test
```

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| `APP_ENV` | `development` (default) | `staging` | `production` |
| Data | your own | a copy for testing (never real customer data without authorization) | real |
| Database | local | its own MySQL database and account | its own MySQL database and account |
| Banner | — | "STAGING" on every page | — |
| Start-up checks | — | — | refuses to start without `SETUP_KEY`, `COOKIE_SECURE=true`, `DB_PASSWORD`, its own (non-root) database account, `DEMO_ENABLED=false` and `BACKUP_ENCRYPTION_KEY` |

Each environment has its own `.env` (see `.env.staging.example` and `.env.production.example`).
`.env` files are never committed; on servers they live in `/opt/serenova/shared/.env`, readable only by
the service account.

## Preparing a server (once per environment)

1. Ubuntu 22.04 or 24.04, Node.js 22, MySQL 8.4, nginx (or Caddy) with an HTTPS certificate.
2. MySQL: one database and one account for the application, with rights on that database only:
   ```sql
   CREATE DATABASE serenova CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;
   CREATE USER 'serenova'@'localhost' IDENTIFIED BY '<long random password>';
   GRANT ALL PRIVILEGES ON serenova.* TO 'serenova'@'localhost';
   -- for restore drills: a separate, empty database the same account may use
   CREATE DATABASE serenova_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci;
   GRANT ALL PRIVILEGES ON serenova_restore_test.* TO 'serenova'@'localhost';
   ```
3. A service account and folders:
   ```sh
   sudo useradd --system --home /opt/serenova serenova
   sudo mkdir -p /opt/serenova/{releases,shared/data}
   sudo chown -R serenova:serenova /opt/serenova
   ```
4. `/opt/serenova/shared/.env` from `.env.production.example` (`chmod 600`). Generate the backup key
   with `openssl rand -hex 32` and **keep a copy of it somewhere safe, apart from the server**:
   without it, encrypted backups cannot be read.
5. `deploy/serenova.service` → `/etc/systemd/system/serenova.service`; `sudo systemctl enable serenova`.
6. The deploy account (the one the workflow signs in as) needs to write `/opt/serenova` and run
   `sudo systemctl restart serenova` and `sudo journalctl -u serenova` (a sudoers rule for exactly these).
7. nginx: proxy `https://your-domain` to `http://127.0.0.1:3000`; set `TRUST_PROXY=1`.

### Staging on a local VM (no public address, no domain)

`scripts/deploy/setup-staging-vm.sh` does all of the above on an Ubuntu 24.04 VM, served over plain
HTTP on the VM's address (`COOKIE_SECURE=false`, staging only). GitHub's machines cannot reach such a
VM, so the script also installs a GitHub Actions runner on it with the label `serenova-staging`; set
the variable `STAGING_RUNNER` to that label and the staging job runs there, deploying to
`deploy@127.0.0.1`. The script prints the exact variables and secrets to enter.

The repository is public: under Settings → Actions → General, set *Fork pull request workflows from
outside collaborators* to **Require approval for all outside collaborators**, so nobody else's code can
run on the VM's runner without your approval.

## Connecting GitHub (once)

In the repository settings:

- **Environments**: create `staging` and `production`. On `production`, add **Required reviewers**
  (the people who approve releases) and allow deployments from `main` only.
- **Variables**: `STAGING_HOST`, `STAGING_USER`, `STAGING_URL`, `PRODUCTION_HOST`,
  `PRODUCTION_USER`, `PRODUCTION_URL`.
- **Environment secrets** (in each environment): `DEPLOY_SSH_KEY` (a key used only for deployments)
  and `DEPLOY_KNOWN_HOSTS` (the server's host key line, from `ssh-keyscan`, checked before use).

Until the variables are set, the deploy workflow builds the release and stops there.

## What a deployment does

1. **Build** (once): checks that the commit is on `main` and passed CI, builds it, and packs it
   without `.env` files, data or `.git`.
2. **Staging**: copies the release to the server, unpacks it into `releases/<commit>`, installs
   dependencies, points `current` at it and restarts the service. On start, the new release writes
   a full backup of the database and then applies any database upgrade.
3. **Health check**: `/readyz` must answer `ready` (database reachable and at this release's
   schema) within two minutes, or the code is switched back to the previous release.
4. **Smoke test** (`scripts/smoke-test.mjs`): liveness, readiness and version, the app page with
   its security headers, the API and console answering, requests without the app header refused,
   protected data requiring a sign-in.
5. **Production**: the same steps, after a required reviewer approves the deployment in GitHub.

CI also starts every build in staging mode against an empty database and runs the smoke test, so
a release that cannot start or upgrade an empty database never reaches a server.

## Database changes

- Migrations only add (tables, columns, data). They run when the new release starts, after a full
  backup, under a lock so two servers never migrate at once.
- A release that has to be rolled back keeps working with the upgraded database.
- Databases are **never rolled back automatically**. If data changed by an upgrade must be undone,
  follow `docs/RECOVERY.md` (restore the pre-migration backup, which the service wrote before upgrading).

## Rolling back

Automatic: a release that does not become healthy is switched back to the previous one.

By hand (e.g. a problem found after the release went live):

```sh
ls -1t /opt/serenova/releases                          # newest first
sudo -u serenova ln -sfn /opt/serenova/releases/<previous-commit> /opt/serenova/current
sudo systemctl restart serenova
curl -fsS http://127.0.0.1:3000/readyz
```

Or run the Deploy workflow by hand ("Run workflow") with the previous commit.

## Release history

- `CHANGELOG.md` describes every release; bump `version` in `package.json` and
  `src/server/version.ts` together (a test checks they agree with the newest changelog entry).
- Each server records every release it starts with (version, commit, environment, database
  upgrade, success or the error). The platform console (`/#/platform` → Releases) shows this history,
  the installed and latest approved release, the release notes and the restore drills. The console
  is read-only: it cannot deploy or change releases.
