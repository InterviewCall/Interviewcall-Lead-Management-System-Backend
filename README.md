# InterviewCall CRM backend

One NestJS app that starts two ways, plus a shared Prisma data layer.

| Where | What |
| --- | --- |
| `apps/api/src/main.ts` | HTTP entry (`crm-api`). Everything is under `/api/v1`; `/health` sits outside it. |
| `apps/api/src/worker.ts` | Worker entry (`crm-worker`): same modules, no HTTP server. Will run the BullMQ processors and the nightly timers. |
| `apps/api/src/modules/<module>` | The ten modules: `iam`, `leads`, `pipeline`, `engagement`, `assignment`, `timeline`, `intake`, `imports`, `reports`, `admin`. |
| `libs/model` | Prisma 7 data layer (`ModelService`) and the schema, one `.prisma` file per module in `libs/model/prisma/schema/`. |

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

Settings: `ACCESS_TOKEN_SECRET` (32+ characters, required), `ACCESS_TOKEN_TTL_MINUTES`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_DOMAIN` (leave empty locally), `CRM_WEB_ORIGIN`.
