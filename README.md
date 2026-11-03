# InterviewCall CRM backend

One NestJS app that starts two ways, plus a shared Prisma data layer.

| Where | What |
| --- | --- |
| `apps/api/src/main.ts` | HTTP entry (`crm-api`). Everything is under `/api/v1`; `/health` sits outside it. |
| `apps/api/src/worker.ts` | Worker entry (`crm-worker`): same modules, no HTTP server. Will run the BullMQ processors and the nightly timers. |
| `apps/api/src/modules/<module>` | The ten modules: `iam`, `leads`, `pipeline`, `engagement`, `assignment`, `timeline`, `intake`, `imports`, `reports`, `admin`. |
| `libs/model` | Prisma 7 data layer (`ModelService`) and the schema, one `.prisma` file per module in `libs/model/prisma/schema/`. |
| `libs/rate-limit` | `@app/rate-limit`: `@RateLimit({ limit, windowSeconds })` for a route, counted in Redis per signed-in user (or per IP on public routes). Over the limit: `429 RATE_LIMITED` with `Retry-After`. If Redis is down requests are let through. |
| `libs/rbac` | `@app/rbac`: roles, the global session guard, `@Public()` / `@Roles()` / `@CurrentUser()` and the access-token verifier. Any API imports this to protect its routes. It never touches the database or `apps/`. |

## Module rules

- A table has exactly one owner. Only the owner's repository (`apps/api/src/modules/<module>/<module>.repository.ts`) reads or writes it.
- A module's `index.ts` exports only its module and service. Other modules import `@modules/<module>`, never its repository or Prisma models. `npm run lint` fails on a relative cross-module import, a deep `@modules/<m>/...` import, or Prisma used outside a repository.
- Calls only go downward: assignment → engagement → pipeline → leads → timeline, with `iam` and `admin` beneath. `timeline`, `admin` and `reports` call nobody else.
- One request that touches several modules runs in one database transaction, passed down as a parameter.

| Module | Tables |
| --- | --- |
| iam | staff_users, auth_sessions, source_credentials |
| leads | leads, lead_identities, lead_sources, touchpoints, form_responses, bookings, custom_field_definitions, saved_views |
| pipeline | opportunities, opportunity_stage_changes, lost_reasons |
| engagement | outcomes, activities, tasks, notifications |
| assignment | lead_assignments, distribution_cursors |
| timeline | lead_events |
| intake | inbox_events, reconciliation_cursors |
| imports | import_jobs, import_rows |
| admin | audit_log, app_settings |
| reports | none (read-only queries) |

## Getting started

```bash
cp .env.example .env          # fill in the values
npm install
npm run prisma:generate
npm run prisma:migrate        # creates the schema in your local MySQL
npm run seed                  # admin user, lead sources, lost reasons, cursors
npm run start:dev             # HTTP API
npm run start:worker          # worker (separate terminal)
```

## Validation and errors

Controllers validate input by passing a zod schema to the decorator: `@Body({ schema: loginSchema })`. One global pipe (`apps/api/src/common/validation.ts`) checks it and hands the controller the parsed value. Every error leaves the API as `{ code, message, fields? }` (`apps/api/src/common/api-exception.filter.ts`). Throw `new HttpException({ code: 'SOME_CODE', message: '...' }, status)` from a service to choose the code.

## Authentication (iam)

Every route needs a signed-in staff session unless it is marked `@Public()`. One global guard (`SessionGuard` in `libs/rbac`, imported as `@app/rbac`) reads the `crm_access` cookie, checks the `X-CSRF-Token` header on writes, holds back accounts that still have a temporary password, and applies `@Roles(...)`. The signed-in user is available in a controller as `@CurrentUser()`.

`POST /api/v1/auth/login` with `{ email, password }`:

- **200** returns `{ user }` and sets three cookies: `crm_access` (15 min) and `crm_refresh` (7 days, sent only to `/api/v1/auth`), both HttpOnly, and `crm_csrf`, which the web app reads and echoes in an `X-CSRF-Token` header.
- **401** `INVALID_CREDENTIALS` for an unknown email, a deactivated account or a wrong password. All three look the same.
- **423** `ACCOUNT_LOCKED` for 15 minutes after 10 wrong passwords.
- **400** `VALIDATION_FAILED` with `fields` for a malformed body.

Local check against the seeded admin:

```bash
curl -i -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<SEED_ADMIN_EMAIL>","password":"<SEED_ADMIN_PASSWORD>"}'
```

iam issues the tokens (login, password change); `libs/rbac` only verifies them. To protect another API, import `RbacModule` from `@app/rbac` and set the same `ACCESS_TOKEN_SECRET`. The secret is shared (HS256), so every verifying API could also mint tokens; before a second API goes live, move to a key pair (iam keeps the private key, other APIs get the public one). That change is confined to `libs/rbac/src/access-token.ts` and iam's `token.service.ts`.

Settings: `ACCESS_TOKEN_SECRET` (32+ characters, required), `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_DOMAIN` (leave empty locally), `CRM_WEB_ORIGIN`, `TRUST_PROXY`, `REDIS_URL` (the rate limiter and the email queue both use it).

### Staying signed in

| Route | What it does |
| --- | --- |
| `POST /api/v1/auth/refresh` | Public, but needs the `crm_refresh` cookie and the `X-CSRF-Token` header. Replaces the refresh token and renews the access token; returns `{ user }`. **401** means the sign-in is over: go to the login page. |
| `POST /api/v1/auth/logout` | Same requirements; works after the access token has expired. Ends this sign-in on the server and clears the cookies. Always **204**. |
| `GET /api/v1/auth/me` | Who is signed in, read from the database (so a changed role, a deactivated account or a logged-out sign-in shows up straight away). Open to an account with a temporary password: call it on load to choose between the app and the "choose a new password" screen. |

- Every refresh replaces the refresh token. Presenting an old one again means a copy exists somewhere else, so the **whole sign-in ends** and an `auth.refresh_reuse_detected` line is written to the audit log.
- Two tabs often refresh together. A token used again within 10 seconds of being replaced is treated as the same user: the second tab gets a new access token only and keeps the refresh cookie it already has. The web app should still send one refresh at a time where it can.
- The role is read from the database at each refresh, so a role change reaches the access token within one refresh (at most 15 minutes).
- **What logout and deactivation do not do:** an access token that was already issued stays valid until it expires (15 minutes). The cookie is cleared in the browser, `/auth/me` and every admin route check the database and refuse straight away, and the refresh token is dead; other routes accept the old access token until it expires. Shorten `ACCESS_TOKEN_TTL_MINUTES` if that window is too long.

### Managing staff (admin only)

| Route | What it does |
| --- | --- |
| `GET /api/v1/staff` | One page, newest first: `?search=` (name or email), `?role=`, `?status=PENDING\|ACTIVE\|DEACTIVATED`, `?page=`, `?pageSize=` (default 25, max 100). Returns `{ staff, page, pageSize, total }`. |
| `PATCH /api/v1/staff/:id` | Change `name` and/or `role`. Email is the sign-in identity and cannot be edited. You cannot change your own role (**409** `CANNOT_CHANGE_OWN_ROLE`), so there is always an admin who can undo a mistake. |
| `POST /api/v1/staff/:id/deactivate` | Switch the account off and end all its sessions. You cannot deactivate yourself (**409** `CANNOT_DEACTIVATE_SELF`). Repeating it does nothing. |
| `POST /api/v1/staff/:id/reactivate` | Switch it back on as **PENDING** with a new emailed one-time password; the old password never comes back. **409** `STAFF_ALREADY_ACTIVE` for an active account. If the email cannot be queued the account goes back to deactivated. |

Staff routes check the admin role against the database, not only the token, so a demoted or deactivated admin is refused at once.

### Audit log

Table `audit_log` (owned by the admin module), one row per event: `auth.login`, `auth.login_failed`, `auth.account_locked`, `auth.logout`, `auth.password_changed`, `auth.password_change_failed`, `auth.refresh_reuse_detected`, `staff.created`, `staff.updated`, `staff.deactivated`, `staff.reactivated`, `staff.password_reset`. A row holds who (staff id), what, which account (public id), the IP and a small `detail` of field names and roles. It never holds emails, names, passwords or tokens. A failed login for an unknown email is recorded without the email.

Writing a row never fails the request it describes: if the audit insert fails, the error is logged and the request carries on. There is no endpoint to read the log yet; query the table.

### Rate limits

| Route | Limit | Counted per |
| --- | --- | --- |
| `POST /auth/login` | 60 per 15 min | IP |
| `POST /auth/refresh` | 120 per minute | IP |
| `POST /auth/logout` | 60 per minute | IP |
| `POST /auth/password` | 10 per 15 min | signed-in user |
| `POST/PATCH /staff...` | 30 per minute | signed-in admin |

Login allows 60 so that a whole office behind one address can sign in together; the account lock (10 wrong passwords) is what stops password guessing. Behind a load balancer or nginx set `TRUST_PROXY=1` (the number of proxies in front), otherwise every user shares the balancer's address. Requests the guard rejects (not signed in, bad CSRF) are not counted.

### Onboarding a staff member

1. An admin calls `POST /api/v1/staff` with `{ name, email, role }`. The account is created as **PENDING** with a random one-time password, which is emailed to the new person and shown to nobody else.
2. They sign in with the emailed password. Login works, but every route except `POST /api/v1/auth/password` answers `403 PASSWORD_CHANGE_REQUIRED`.
3. They choose their own password (10+ characters) with `POST /api/v1/auth/password` `{ currentPassword, newPassword }`. The account becomes **ACTIVE**, every earlier session ends, and they get fresh cookies.

`POST /api/v1/staff/:id/reset-password` (admin) issues a new one-time password the same way: the old password stops working, the user's sessions end and the account is pending again.

Status is derived: `DEACTIVATED` if `is_active` is off, otherwise `PENDING` while `must_change_password` is set, otherwise `ACTIVE`.

## Notifications

Anything that sends a message queues it with `NotificationService.enqueue({ channel, recipient, template, data })` and returns. A BullMQ worker (`npm run start:worker`) picks the job up and hands it to the executor for its channel. The API process never sends anything itself, so **the worker and Redis must be running for emails to go out**.

Each channel is a strategy, a class that implements `NotificationExecutor`:

```
apps/api/src/notifications/
  notification.executor.ts        the interface: channel + send(message)
  notification.service.ts         enqueue() — used by the modules
  worker/
    notification.dispatcher.ts    picks the executor for a message's channel
    email.executor.ts             EMAIL: Handlebars template -> Amazon SES
    templates/<name>/             email templates: subject.hbs, text.hbs, html.hbs
```

To add a channel (WhatsApp, SMS): write a class that implements `NotificationExecutor`, add it to `providers` in `notifications-processor.module.ts`, and add it to the `NOTIFICATION_EXECUTORS` list there. To add a template: add its data to `NotificationTemplates` in `notification.types.ts`, create `worker/templates/<name>/` with `subject.hbs`, `text.hbs` and `html.hbs`, and register it in `worker/templates/index.ts`. The build inlines the `.hbs` files into the bundle (see `rspack.config.cjs`), so nothing is read from disk at run time. In `html.hbs` values are HTML-escaped; in `subject.hbs` and `text.hbs` they are not. A placeholder with no value makes the render fail instead of sending a blank.

Failed jobs retry up to 5 times with backoff. Finished jobs are deleted at once (they can carry a one-time password); failed ones are kept for 24 hours.
