# Exam Platform — Build Plan

Derived from PRD v1.3. Phased so each phase is demoable and de-risks the next. Security-critical pieces (custom student auth + RLS, server-authoritative timing) are front-loaded.

**Stack:** Next.js on Vercel (frontend), Supabase Postgres/Storage/Realtime (data), Render (all writes + custom auth + AI queue). Authorization lives in Render; RLS is defense-in-depth (PRD §8.1).

---

## Phase 0 — Foundations (infra & skeleton)
- Repo layout: `web/` (Next.js), `api/` (Render service), `supabase/migrations/`, `docs/`.
- Provision: Supabase project, Render service, Vercel project. Wire env/secrets (`.env` + Vercel/Render dashboards). **Never** ship the Supabase service-role key to the frontend.
- CI: lint + typecheck + migration check on PR.
- Health-check endpoints and a "hello" page deployed end-to-end (proves the three services talk).
- **Exit:** a deployed skeleton with all three services connected.

## Phase 1 — Data model & auth spine  *(highest risk — do carefully)*
- Apply migration `0001_initial_schema.sql` (§9 tables, enums, indexes, RLS enabled).
- **Teacher/admin auth:** Supabase Auth (email/password). Role stored in `users`.
- **Custom student auth (Render):** roll number + access code → roster/eligibility → session-conflict check → issue short-lived JWT carrying a custom claim (`roll_number`, `exam_id`). Supabase RLS reads that claim.
- **Single active session:** `active_sessions` table; new login blocked if a live session exists (PRD §5.2). Log the conflict.
- Roster CSV import (course-level + exam overrides `inherit`/`replace`/`extend`).
- **Exit:** a teacher can log in; a rostered student can obtain a scoped session token; a duplicate login is blocked and logged. RLS verified with tests (student A cannot read student B's rows).

## Phase 2 — Course & exam management
- CRUD: courses, co-teachers, rosters. Exam CRUD with all config fields (schedule, `no_entry_after`, access code, backtracking, violation policy, `show_explanations`, marks, passing %).
- Manual question authoring (MCQ + options, essay + model answer).
- **Exit:** teacher builds a complete exam by hand and schedules it.

## Phase 3 — Exam-taking engine  *(second-highest risk — timing)*
- **Server-authoritative timer:** remaining time computed server-side each request; entry-window (`no_entry_after`) enforced; **every answer write validated against `end_at`** and rejected if late (PRD §4.1).
- Answer persistence as entered → resume-on-interruption (PRD §4.10).
- Randomization (question + option shuffle; optional question-bank draw). Backtracking honors per-exam config.
- Submission paths: manual, timer auto-cutoff, violation auto-close.
- **`pg_cron` sweeper** for abandoned/expired attempts (backstop only).
- **Exit:** a student takes a timed exam, gets cut off correctly at `end_at`, and can resume after a forced tab close without losing answers or gaining time.

## Phase 4 — Anti-cheating / lockdown
- Fullscreen enforcement, tab/window blur + visibility detection, back-button interception.
- Violation logging + escalation policy engine (`warn` / `warn+limit` / `zero-tolerance`, configurable strike count).
- Watermarking (name/ID + timestamp); right-click/PrintScreen/Ctrl+P/dev-tools deterrence, each logged.
- Unsupported-browser/mobile gate with clear messaging.
- **Exit:** violations flag correctly, escalate per policy, and auto-submit on the final strike.

## Phase 5 — Live monitoring dashboard
- RLS-scoped Realtime subscriptions on `attempts`/`violations`; grid/roster view with status, progress, violation feed, and session-conflict events.
- **Load test** ~1,000 students; if Realtime limits bite, add server-side aggregation (periodic pushed snapshots) instead of raw per-row fan-out (PRD §6.1).
- **Exit:** teacher watches a live cohort; verified under load.

## Phase 6 — Grading, results & analytics
- Auto-grade MCQ on submit; manual essay grading UI.
- Post-exam analytics (distribution, avg/median, pass/fail, per-question item difficulty), per-student drill-down.
- Student review (right/wrong; explanations gated by per-exam toggle). Course-level roll-up (§6.4). CSV export.
- **Exit:** full grade → review → export cycle works.

## Phase 7 — AI generation & grading
- Notes upload → Supabase Storage. Render async queue (BullMQ/Celery).
- **Provider interface** (initially Gemini): MCQ + essay generation; essay first-pass suggested score + rationale.
- **Human-in-the-loop:** review queue for questions; essay scores stay `pending` until teacher confirms/overrides; overrides logged.
- **Exit:** teacher generates questions from notes, reviews/approves, and confirms AI-suggested essay scores — nothing reaches students unreviewed.

## Phase 8 — Admin tooling & audit
- Teacher provisioning, course-creation permissions.
- Attempt reset/re-open; login-problem resolution workflow (§5.3).
- Audit-log viewer (grading overrides, resets, conflict events).
- **Exit:** admin resolves a stuck-login and a wrongful auto-submit end-to-end; every action is in the audit trail.

---

## Cross-cutting (every phase)
- **Audit logging** wired as features land (don't retrofit).
- **RLS tests** whenever a new table/claim is touched.
- **Accessibility** (WCAG 2.1 AA) checked per screen.
- All timestamps **UTC**; display in exam timezone.

## Suggested sequencing
Phases are mostly sequential; 4 and 5 can run in parallel after 3, and 7 can run in parallel with 5–6 once 2 is done. Phases 1 and 3 are the two to slow down and get right.
