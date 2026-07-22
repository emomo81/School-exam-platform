# School Exam Platform

Web-based digital examination platform: timed exams, anti-cheating enforcement, AI-assisted question generation/grading, roster-based access, and live monitoring/reporting.

See [`docs/`](docs/) for the spec:
- [PRD v1.3](<Exam-Platform-PRD (3).md>) — product requirements.
- [Build plan](docs/BUILD-PLAN.md) — phased delivery.
- [Auth spec](docs/AUTH-SPEC.md) — custom student auth + session model.

## Repo layout

```
web/                 Next.js app on Vercel (student UI + teacher/admin dashboards)
api/                 Render service — all writes, custom student auth, AI queue
supabase/migrations/ Postgres schema (apply in order)
docs/                Specs
```

Authorization model (PRD §8.1): **Render owns all writes and holds the service-role key.**
The frontend reads Supabase directly only for RLS-scoped Realtime. Never ship the
service-role key or the JWT secret to the browser.

## Local development

Prereqs: Node ≥ 20, a Supabase project, and (for the API) its service-role key + JWT secret.

```bash
npm install                    # installs web + api workspaces
cp web/.env.example web/.env.local   # fill in Supabase URL + anon key + API URL
cp api/.env.example api/.env          # fill in service-role key + JWT secret

npm run dev:web                # Next.js on http://localhost:3000
npm run dev:api                # API on http://localhost:8080
```

Health checks: `GET http://localhost:3000/api/health` and `GET http://localhost:8080/health`.

## Database

Apply migrations in `supabase/migrations/` in filename order (via the Supabase SQL editor,
CLI, or MCP). `0001` creates the schema + RLS; `0002` adds the exam access-code unique constraint.
