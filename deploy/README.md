# LeadNest: production setup

One small AWS server runs the API and the worker (Docker), MySQL (Docker) and HTTPS (Caddy). The queues use **Redis Cloud**.
The web app is a normal Next.js project on **Vercel**. Push to `main` and GitHub builds the images and deploys them
(with automatic rollback if the new version does not start).

Expected load is small (about 15 BDAs), so one **`t4g.medium`** (2 vCPU, 4 GB, Arm) is plenty. Cost is roughly
**$30/month** for the server, disk and fixed IP, plus Redis Cloud. About 30 minutes the first time.

Everything below is in the AWS region **Asia Pacific (Mumbai) `ap-south-1`**. Pick it in the console before you start,
and check the region name at the top right on every page.

---

## Part 1: AWS (a brand-new account)

**1. Email (SES)**: staff get their one-time passwords by email.
- SES -> Identities -> Create identity -> Domain: the domain you send from (e.g. `mailing.interviewcall.club`).
  Add the 3 DKIM CNAME records it shows at your DNS provider. (A domain already verified in another AWS account can be
  verified again here; the records do not clash.)
- SES -> Account dashboard -> **Request production access**. A new account is in the *sandbox*: until AWS approves it,
  mail only reaches addresses you have verified (Identities -> Create identity -> Email address). Request it on day one.
- IAM -> Users -> Create user `leadnest-ses` -> attach a policy allowing `ses:SendEmail` and `ses:SendRawEmail` ->
  Security credentials -> Create access key. Keep the key id and secret.

**2. Key pair**: EC2 -> Key pairs -> Create key pair -> name `ic-crm`, type RSA, format `.pem`. The file downloads; keep it safe.

**3. Security group**: EC2 -> Security groups -> Create -> name `leadnest-sg`. Inbound rules, all from `0.0.0.0/0`:
SSH (22), HTTP (80), HTTPS (443). Nothing else (never 3306).
Keep SSH open to everyone: GitHub deploys from changing addresses, and the server only accepts your key.

**4. Launch the server**: EC2 -> Launch instance
- Name `leadnest`
- Image **Ubuntu Server 24.04 LTS**, architecture **64-bit (Arm)** (the login user is `ubuntu`;
  on Amazon Linux 2023 it is `ec2-user`, use that wherever `ubuntu` appears below)
- Type **t4g.medium**
- Key pair `ic-crm`, security group `leadnest-sg`
- Storage **30 GiB gp3**
- Launch.

**5. Fixed IP**: EC2 -> Elastic IPs -> Allocate Elastic IP address -> Actions -> Associate -> pick `leadnest`. Note the IP.

**6. DNS**: at your domain provider add an **A record** for the API hostname (e.g. `crm-api.interviewcall.club`) pointing to
that IP. (Cloudflare: "DNS only".) The web app (e.g. `crm.interviewcall.club`) is added in Vercel in Part 5.
The web app and the API **must share a parent domain**, because the sign-in cookies are set on it.

## Part 2: Redis Cloud

Create a database in **AWS Mumbai** (same region as the server). Set the **data eviction policy to `noeviction`**
(the queues must never silently lose jobs) and keep persistence on (append-only file every second).
If you use its allow-list, add the server's Elastic IP.
Build the URL `rediss://default:<password>@<host>:<port>` (use `redis://` if TLS is off).

## Part 3: GitHub token (once)

GitHub -> Settings -> Developer settings -> Personal access tokens -> **Tokens (classic)** -> Generate -> tick only
**`read:packages`**. (The server uses it to download your private images. If the repo belongs to an organisation,
click "Configure SSO / Authorize" on the token.)

## Part 4: Set up the server (one command)

On your laptop, from the backend repo folder:
```bash
chmod 400 ~/Downloads/ic-crm.pem
scp -i ~/Downloads/ic-crm.pem -r deploy ubuntu@<ELASTIC_IP>:~/
ssh -i ~/Downloads/ic-crm.pem ubuntu@<ELASTIC_IP>
sudo bash deploy/install.sh
```
It installs Docker and asks for the values (hostname, web app URL, Redis URL, first admin, GitHub name and token, SES keys).
It generates all passwords itself and starts MySQL and HTTPS. Re-running it is safe.

## Part 5: Deploy

1. Backend repo -> Settings -> Secrets and variables -> Actions -> **New repository secret**:

   | Secret | Value |
   |---|---|
   | `EC2_HOST` | the Elastic IP |
   | `EC2_USER` | `ubuntu` |
   | `EC2_SSH_KEY` | the full contents of `ic-crm.pem` (including the BEGIN/END lines) |

2. Merge `develop` into `main`. Watch the **Actions** tab: tests, the image build (5-10 minutes the first time), then the deploy.
   The first deploy creates the database, applies all migrations and seeds the first admin, lead sources, call outcomes and lost reasons.
3. Check `https://<API hostname>/health` answers `{"status":"ok"}`.
4. **Vercel**: import the web repo, framework Next.js, production branch `main`. Environment variable
   `NEXT_PUBLIC_API_URL` = `https://<API hostname>/api/v1`. Add the web domain (e.g. `crm.interviewcall.club`).
5. **First sign-in**: open the web app and sign in with the admin email and the password you gave the installer (it is not temporary, so you are not asked to change it).
   Then you can delete the `CRM_SEED_ADMIN_PASSWORD` line from `/opt/leadnest/settings.env` on the server: it is only read by the first seed, and it never changes an existing admin's password.
   In **Team** add your staff (each gets a one-time password by email).

## Part 6: Connect the VSL services (they run on the other server)

The form and booking services send their leads to LeadNest over the internet, with a key each.
1. LeadNest -> Intake monitor -> Source keys: create one key for "VSL form" and one for "VSL slot booking" (each is shown once).
2. On the **booking server**, in `/opt/ic-booking/settings.env` add:
   ```
   CRM_API_URL='https://<API hostname>/api/v1'
   CRM_FORM_INTAKE_KEY='ick_...'
   CRM_BOOKING_INTAKE_KEY='ick_...'
   ```
   then `sudo /opt/ic-booking/bin/render-env.sh` and re-run the form and booking services' deploy workflows (Actions -> Run workflow).
3. Past leads can be sent once with each service's `crm:backfill` command.

---

## Everyday use

Log in: `ssh -i ic-crm.pem ubuntu@<ELASTIC_IP>`, then:

| Task | Command |
|---|---|
| See what is running | `sudo docker ps` |
| Live logs | `sudo docker logs -f --tail 100 leadnest-crm-api-1` (also `leadnest-crm-worker-1`, `leadnest-mysql-1`, `leadnest-caddy-1`) |
| Change a setting (SES, URLs, keys) | `sudo nano /opt/leadnest/settings.env` -> `sudo /opt/leadnest/bin/render-env.sh` -> GitHub -> Actions -> Deploy -> Run workflow |
| Run a database query | `sudo docker exec -it leadnest-mysql-1 mysql -uroot -p` (root password: `MYSQL_ROOT_PASSWORD` in `settings.env`) |
| Roll back a bad release | `git revert` it and push, or re-run an older deploy: `sudo /opt/leadnest/bin/deploy.sh ghcr.io/<owner>/leadnest:<older sha> ghcr.io/<owner>/leadnest-migrate:<older sha>` |

**MySQL Workbench** (MySQL listens only on the server's own loopback, so you go through an SSH tunnel):
1. Keep this running on your laptop: `ssh -i ~/Downloads/ic-crm.pem -N -L 3307:127.0.0.1:3306 ubuntu@<ELASTIC_IP>`
2. Workbench -> new connection -> Standard (TCP/IP), host `127.0.0.1`, port `3307`, user `root`, the `MYSQL_ROOT_PASSWORD`.
The database is `leadnest`. Never open port 3306 in the AWS firewall.

**Backups**: every night at 02:30 IST the database is dumped to `/opt/leadnest/backups` (7 days kept).
Restore: `gunzip -c /opt/leadnest/backups/leadnest-YYYY-MM-DD.sql.gz | sudo docker exec -i -e MYSQL_PWD=<root password> leadnest-mysql-1 mysql -uroot`.
The backups sit on the same disk, so also turn on **disk snapshots** (2 minutes):
EC2 -> Elastic Block Store -> Lifecycle Manager -> Create lifecycle policy -> target the instance `leadnest`, daily, keep 7.
Redis Cloud keeps its own copy of the queues; the real data is all in MySQL.

**Bigger server later**: EC2 -> stop the instance -> Actions -> Instance settings -> Change instance type -> start. The IP stays.

## Good to know

- Everything is on one machine: if it dies you restore from a snapshot or backup (about 15 minutes of work); there is no automatic failover.
- MySQL and Redis are not reachable from the internet. Only ports 22, 80 and 443 are open, and SSH is key-only.
- Run exactly one `crm-worker` (it owns the queues and the timers) and one `crm-api`.
- Database migrations are not undone on rollback, so keep them backward compatible.
- There is no public "forgot password": an admin resets a password from Team, and the person gets a one-time password by email.
