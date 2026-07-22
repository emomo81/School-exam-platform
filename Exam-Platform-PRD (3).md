# Exam Platform — Product Requirements Document

**Version:** 1.3
**Status:** Draft — open questions from v1.2 resolved into firm decisions (see change log at end).
**Purpose:** Define requirements for a web-based digital examination platform supporting timed exams, anti-cheating enforcement, AI-assisted question generation/grading, roster-based access control, and monitoring/reporting dashboards for teachers and students.

---

## 1. Overview

The platform allows teachers to create, schedule, and administer exams to a pre-approved roster of students, with automatic timing, shuffling, grading, anti-cheating enforcement, and post-exam analytics for both teachers and students.

## 2. Courses (First-Class Entity)

A **Course** sits above individual exams and is the primary container for roster and ongoing results.

- A teacher creates a **Course** (e.g., "BIO 201 — Fall 2026") and enrolls a roster of students **once**, via manual entry or CSV bulk upload.
- A course can contain **multiple exams** (e.g., Quiz 1, Midterm, Final). Each exam under a course:
  - **Inherits the course roster by default** — no need to re-upload student lists per exam.
  - Can optionally **override** the roster for a specific exam (see §2.1).
- **Roles at course level:**
  - A course has **one primary teacher** plus optional **co-teachers/TAs**. Co-teachers have the same capabilities as the primary teacher *except* they cannot delete the course or remove the primary teacher. (Decision: multi-teacher is supported; single-teacher is just the case of zero co-teachers.)
  - A student's enrollment in a course grants **eligibility** for exams under it, but does **not** itself unlock any exam — each exam is still gated by its own access code and schedule (see §5.2). (Confirms v1.2 open question #10.)
- **Roster lifecycle:** adding/removing a student from a course roster affects their access to **future** exams and to exams **scheduled but not yet started**. It does **not** retroactively alter access to an exam already in progress or completed.
- **Results roll-up:** a student's performance across all exams within a course can be viewed together (see §6.4), not just exam-by-exam.

### 2.1 Exam Roster Override Modes

An exam either inherits the course roster or defines an override. Overrides have an explicit **mode**:

- **`inherit`** (default) — the exam is available to the full course roster.
- **`replace`** — the exam is available **only** to the listed roll numbers (e.g., a make-up exam for a subset). The course roster is ignored for this exam.
- **`extend`** — the exam is available to the course roster **plus** the listed extra roll numbers (e.g., a guest cohort).

Override rosters can be added manually or via CSV. Editing an override never alters the course-level roster.

## 3. User Roles

- **Teacher/Instructor** — creates and manages courses, creates exams within a course, manages course/exam rosters, monitors live activity, reviews AI-generated content and AI-suggested essay scores, views results/analytics (per-exam and per-course). Authenticates via email/password (Supabase Auth).
- **Student** — enrolled in one or more courses; logs in with **roll number + exam access code** (no separate per-student password) to access a specific exam; reviews their own results afterward, per-exam and cumulatively across a course.
- **Admin** — manages institutional accounts, teacher provisioning, and course-creation permissions; **resolves student login problems** (see §5.3); can reset/re-open a student's exam attempt (see §4.10); has read access to audit logs. Authenticates via email/password (Supabase Auth).

## 4. Functional Requirements

### 4.1 Timer (Fixed End-Time Model)
- Teacher sets a **start time** and **duration** (e.g., 1:00 PM, 2 hours), which locks a shared, absolute **end time** (e.g., 3:00 PM) for all students, regardless of when each student opens the exam.
- A student's remaining time = **end time − the moment they open the exam** (e.g., opening at 1:30 PM leaves 1 h 30 m).
- **Late entry:** a teacher-configurable **"no entry after" time** governs the latest a student may start. Default = the exam start time + a configurable grace window (default 30 minutes), and it can never exceed the end time. A student attempting to open the exam after this cutoff is denied entry.
- **Timezones:** all times are stored and compared in **UTC**; the UI displays them in the exam's configured timezone. No timing logic ever relies on client clocks.
- **Authoritative timing (non-negotiable):**
  - Timer logic is computed **server-side on every request**; the client only displays it. This prevents spoofing via dev tools, refreshing, or retrying.
  - **Every answer write is validated server-side against the end time** and rejected if it arrives after the cutoff. This — not the sweeper below — is the authoritative gate for near-cutoff integrity (§7).
  - A **server-side sweeper job** (`pg_cron`, see §8) auto-submits/locks any exam whose end time has passed but is not yet marked submitted, covering students whose connection dropped. Because `pg_cron`'s finest granularity is one minute, the sweeper is a backstop for abandoned sessions, not the primary cutoff mechanism.

### 4.2 Question Randomization
- Questions and answer options can be shuffled per student.
- **Question-bank mode (optional):** draw N random questions from a larger pool so each student receives a distinct set, not just a reordering of the same set.

### 4.3 Backtracking Prevention (Configurable)
- Backtracking is an **instructor-configurable per-exam setting**, defaulting to enabled (backtracking allowed). When disabled, students cannot return to previously answered questions. The exam UI reflects the actual configured value rather than hardcoding one policy.

### 4.4 Scale
- Designed to support **hundreds of concurrent students** (target: ~500–1,000 concurrent, see §10).

### 4.5 Automatic Grading
- MCQ/objective questions auto-graded on submission.
- Essay questions routed to manual or AI-assisted grading (see §4.9).

### 4.6 Manual Question Creation
- Teacher can create exams by manually entering questions and answers directly, without any notes upload.

### 4.7 Lockdown / Anti-Cheating
- **Fullscreen enforcement** during the exam session.
- **Tab/window blur detection** — detects when a student navigates away from or minimizes the exam window.
- **Back-button interception.**
- **Violation escalation policy (instructor-configurable severity):**
  - **Default `warn` (3-strike):** 1st violation → flagged on record; 2nd → final warning to student; 3rd → exam auto-closed/submitted.
  - **`warn+limit`:** stricter thresholds (configurable strike count).
  - **`zero-tolerance`:** first violation auto-submits.
  - The strike count and severity are configurable per exam; the exam UI displays the policy actually in effect rather than a fixed "3 strikes."
- **Screenshot/copy deterrence:**
  - Blocks right-click, PrintScreen key, Ctrl+P, and dev-tools access where technically possible; each attempt is logged as a violation.
  - **Known limitation (must be surfaced to instructors):** browser-based controls cannot prevent a phone-camera photo or OS-level screen recording — no web-based platform can. Screenshot prevention must **not** be oversold as airtight.
  - **Watermarking:** exam content displays a watermark with student name/ID and timestamp as a deterrent and traceability measure (tracing a leaked image back to a student is feasible even though prevention is not).
- **Out of scope (for now):** a dedicated kiosk-mode client to block a second physical device; noted as a possible future addition.

### 4.8 Manual Question Creation from Notes
- Teacher uploads reference notes and writes questions/answers manually alongside them (notes serve as a reference aid, not auto-processed).

### 4.9 AI Question Generation & Grading
- **Provider:** an LLM provider accessed through an internal **provider-abstraction interface**, initially **Gemini**. No requirement is coupled to a specific vendor API, so the provider can be swapped or routed without spec changes.
- Teacher uploads notes; the provider extracts content and generates:
  - **MCQs** with distractor options.
  - **Essay questions** with a model answer derived from the notes.
- **Essay grading (positioned as a first-pass aid, not a grader):** student submissions are compared against the notes/model answer to produce a **suggested** score plus a rationale. Known failure modes are acknowledged in the product: a correct answer phrased differently may score low, and fluent text that echoes the notes may score high. The suggested score is explicitly a drafting aid for the teacher, never an authoritative grade.
- **Human-in-the-loop requirement (critical):** nothing reaches students or final grade records without teacher review:
  - AI-drafted questions sit in a **review queue** before being added to a live exam.
  - AI-suggested essay scores stay **"pending"** until the teacher confirms or overrides them.
  - Overrides are **logged** (original AI score, teacher's final score, timestamp, teacher ID) — see audit logs in §11.
- **Decision:** no fully-automated "no review" grading mode is offered in this version. Review is mandatory.

### 4.10 Attempts, Interruptions & Resets (New)
- **One attempt per exam per student** by default.
- **Resumable within the window:** because the end time is fixed and server-authoritative, a student whose session is interrupted (crash, dropped connection, accidental close) may **reopen the exam and resume** with their saved answers and the correctly reduced remaining time, as long as the end time / "no entry after" rules still permit. Answers are persisted server-side as they are entered so nothing is lost on interruption.
- **Terminal auto-submit:** an attempt auto-submitted by the timer cutoff or by the violation policy is **closed** and cannot be resumed by the student.
- **Admin/teacher reset:** an **admin** (or the exam's teacher) can reset or re-open a student's attempt — e.g., after a verified technical failure or a wrongful auto-submit. Every reset is recorded in the audit log (who, when, reason, prior status).

## 5. Access Control & Authentication

### 5.1 Roles & Provisioning
- **Teachers and admins** authenticate through **Supabase Auth** (email/password). Admins provision teacher accounts and set course-creation permissions.
- **Students** do **not** have platform accounts; they authenticate per-exam (see §5.2).

### 5.2 Student Login
- **Credentials:** **roll number + exam access code**. The access code is **per-exam** (each exam has its own code); there is no per-student password.
- **Eligibility check:** the roll number must appear on the applicable roster — by default the **course roster**, or the exam's **override roster** per §2.1.
  - Roster entries can be added manually or via **CSV bulk upload**.
  - A roll number not on the applicable roster is rejected outright, even with a valid access code.
- Roster edits are permitted up until, or during, the exam window (see §2 lifecycle rules).
- **Session control (single active session):** one roll number may have **only one active session at a time**.
  - **Decision:** if a session is already active for a roll number, **any new login attempt for that same roll number is blocked** (the *existing* session is preserved; the newcomer is denied). This protects the student already taking the exam from being kicked out by a leaked code.
  - A blocked attempt is **logged as a potential-conflict event** visible to the teacher's monitoring dashboard and surfaced to the admin.
- **Known residual risk:** with no per-student password, the access code is the master credential; a leak lets anyone claiming a roster roll number *attempt* entry (though the single-active-session rule means they cannot displace an already-active legitimate student). A second factor (OTP) is **planned for a later version** and intentionally out of scope here.

### 5.3 Login Problem Resolution (New)
- If a student cannot log in for any reason (not on roster, wrong/leaked code, a blocked session-conflict, a device/connection failure), the resolution path is: **the student contacts the admin**, who investigates and fixes it — e.g., correcting a roster entry, clearing a stale active session so the student can re-enter, or resetting the attempt (§4.10).
- The login screen surfaces clear, non-technical failure messaging plus an instruction to contact the admin/invigilator; it never exposes whether a given roll number exists on the roster (to limit enumeration).

## 6. Dashboards & Reporting

### 6.1 Teacher Monitoring Dashboard (Live, During Exam)
- Real-time view of each student's activity during the exam window, including:
  - Connection/session status (active, disconnected, submitted).
  - Progress (questions answered / remaining, time remaining).
  - Violation flags as they occur (strike 1/2/3, with type: tab-blur, fullscreen-exit, screenshot-attempt, etc.).
  - **Session-conflict / blocked-login events** (§5.2).
  - Ability to drill into an individual student's live status.
- Default design: a **live, visual monitoring view** (grid/roster with status indicators and a violation feed) rather than a static post-hoc table — consistent with the dashboard mockups.
- **Scale note (see §10):** subscribing every instructor client directly to per-row `attempts`/`violations` changes for up to ~1,000 students can hit Realtime connection/throughput limits. The design must load-test this and, if needed, fall back to server-side aggregation (periodic pushed snapshots) rather than raw per-row fan-out.

### 6.2 Post-Exam Teacher Analytics
- Overall results per exam: score distribution, average/median, pass/fail breakdown.
- Per-question analytics: how many students missed each question (item difficulty), for spotting ambiguous or miscalibrated questions.
- Per-student results with drill-down into individual answers.
- **Export:** **CSV** of results in this version (raw per-student and per-question). PDF summary export is a later addition.

### 6.3 Student Post-Exam Review
- After the exam is graded, students can review their overall score, and which questions they got right or wrong.
- **Answer explanations are an instructor-configurable per-exam toggle.** Showing correct answers/explanations improves learning but burns the question bank for reuse; the default is **off** (right/wrong status only), and the teacher can enable full explanations per exam.
- Essay questions with AI-assisted grading show the **teacher-confirmed final score**, never the raw AI-suggested score, once review is complete.

### 6.4 Course-Level Results Roll-Up
- **Teacher view:** aggregated performance across all exams in a course, per student (trend across Quiz 1 → Midterm → Final) and per cohort (course-wide averages over time).
- **Student view:** their own cumulative standing across exams within a course, alongside each individual exam's result.
- Additive to, not a replacement for, per-exam results in §6.2/§6.3.

## 7. Non-Functional Requirements
- **Reliability / data integrity near the time cutoff** — enforced by the server-side per-write end-time check (§4.1), with `pg_cron` as the abandoned-session backstop.
- **Concurrency** — support ~500–1,000 simultaneous students (§10); live monitoring must be load-modeled against Realtime limits (§6.1).
- **Auditability** — grading overrides, violation flags, attempt resets, and login-conflict events are all logged (§11).
- **Security** — authorization is enforced server-side (§8); RLS is defense-in-depth, not the sole gate.
- **Accessibility & compatibility** — target WCAG 2.1 AA for teacher/admin dashboards and the student exam UI where compatible with lockdown constraints. **Supported-browser baseline:** current-version desktop Chrome, Edge, and Firefox (the anti-cheat model depends on Fullscreen/visibility browser APIs; mobile and unsupported browsers are blocked from exam-taking with a clear message). Internationalization: UI language is selectable (see settings); exam content language follows the authored content.

## 8. Tech Stack & Architecture

**Confirmed stack:** Vercel (frontend), Supabase (database/storage/realtime), Render (backend services).

### 8.1 Authorization Model (resolved)
**Decision (resolves the v1.2 §8 open item):** **Render is the primary API layer for all application logic and all writes** — courses, exams, rosters, attempts, answers, grading, violations. The frontend does **not** write to Supabase directly.
- The **frontend reads directly from Supabase only for Realtime subscriptions** (live monitoring), which are **read-only and scoped by Row Level Security** using the custom JWT claim.
- **Supabase RLS is defense-in-depth**, not the whole authorization story; the authoritative checks live in Render. This keeps a single trusted place for the load-bearing rules (timing, eligibility, session-conflict, one-attempt) while still allowing efficient pushed updates to dashboards.

### 8.2 Components
- **Frontend:** Next.js (React) on **Vercel** — student exam UI and teacher/admin dashboards. Handles Fullscreen API, tab/blur detection, and consumes Supabase Realtime subscriptions for live dashboard updates.
- **Database:** **Supabase (Postgres)** — stores the entities in §9. Relational structure suits the courses → exams → rosters → attempts hierarchy and supports transactional integrity for grading overrides and audit logs.
- **File storage:** **Supabase Storage** — teacher-uploaded notes/documents (§4.8/§4.9).
- **Live monitoring:** **Supabase Realtime**, subscribing to `attempts`/`violations` (RLS-scoped), with the aggregation fallback noted in §6.1.
- **Server-side timer/cutoff enforcement:** **Supabase `pg_cron`** periodically sweeps expired-but-unsubmitted attempts (backstop); the per-write end-time check in Render/Postgres is the primary gate (§4.1).
- **Backend service (Render):**
  - **Custom student auth** (roll number + access code → roster/eligibility check → session-conflict check → short-lived session token with a custom JWT claim consumed by Supabase RLS). This is the security-critical integration and gets its own detailed design/spec and test coverage before build.
  - **All app-logic write APIs** and authorization-sensitive reads (§8.1).
  - **LLM provider calls** for generation/grading behind the provider interface (§4.9), kept off Vercel because they can be slow / exceed serverless limits.
  - **Async job queue** (e.g., BullMQ or Celery) for AI generation/grading so requests aren't blocked.

## 9. Data Model (New)

Indicative core tables (names/columns to be refined during build; all timestamps UTC):

- **`institutions`** — `id`, `name`, `settings`.
- **`users`** — teacher/admin accounts (backed by Supabase Auth); `id`, `institution_id`, `role` (`teacher`|`admin`), `email`.
- **`courses`** — `id`, `institution_id`, `name`, `term`, `primary_teacher_id`.
- **`course_teachers`** — `course_id`, `user_id`, `role` (`primary`|`co`). (Many teachers per course.)
- **`course_roster`** — `id`, `course_id`, `roll_number`, `student_name`, `email?`. Unique on (`course_id`, `roll_number`).
- **`exams`** — `id`, `course_id`, `title`, `subject`, `start_at`, `end_at`, `no_entry_after`, `timezone`, `duration_minutes`, `access_code`, `roster_mode` (`inherit`|`replace`|`extend`), `backtracking_allowed`, `violation_policy`, `strike_limit`, `show_explanations`, `passing_pct`, `total_marks`, `status`.
- **`exam_roster_overrides`** — `exam_id`, `roll_number` (used when `roster_mode` ≠ `inherit`).
- **`questions`** — `id`, `exam_id` (or `question_bank_id`), `type` (`mcq`|`essay`), `body`, `marks`, `model_answer?`, `source` (`manual`|`ai`), `review_status` (`pending`|`approved`).
- **`question_options`** — `id`, `question_id`, `label`, `is_correct`.
- **`attempts`** — `id`, `exam_id`, `roll_number`, `status` (`in_progress`|`submitted`|`auto_submitted_timer`|`auto_submitted_violation`|`reset`), `opened_at`, `submitted_at`, `remaining_seconds_snapshot`, `score`.
- **`attempt_answers`** — `id`, `attempt_id`, `question_id`, `answer`, `is_correct?`, `awarded_marks?`. Persisted as entered (supports resume, §4.10).
- **`violations`** — `id`, `attempt_id`, `type`, `strike_number`, `occurred_at`.
- **`essay_grades`** — `id`, `attempt_answer_id`, `ai_suggested_score`, `ai_rationale`, `final_score?`, `status` (`pending`|`confirmed`|`overridden`), `graded_by`, `graded_at`.
- **`active_sessions`** — `roll_number`, `exam_id`, `session_token_id`, `opened_at` (enforces single active session / conflict blocking, §5.2).
- **`audit_logs`** — `id`, `actor_id`, `actor_role`, `action`, `entity`, `entity_id`, `before`, `after`, `reason?`, `occurred_at` (grading overrides, attempt resets, login-conflict events).

## 10. Assumptions & Scope

1. Institutional use case, ~500–1,000 concurrent students.
2. One attempt per exam per student (resumable within the window; admin can reset — §4.10).
3. Essays graded manually by default, with optional AI assistance that always requires teacher sign-off — no fully-automated grading mode.
4. Teacher dashboard "uniqueness" = live/visual monitoring (§6.1).
5. Student result review shows right/wrong by default; full explanations are a per-exam instructor toggle (§6.3).
6. Result export is **CSV** in this version; PDF later.
7. **Second-factor authentication (OTP): planned for a later version, out of scope here.**
8. Kiosk-mode client (to prevent second-device use) is out of scope for this version.
9. One primary teacher per course with optional co-teachers/TAs (§2).
10. Course enrollment grants eligibility only; the per-exam access code + schedule still gate entry (§2, §5.2).

## 11. Auditability
The following are always recorded in `audit_logs`: AI-score overrides (original AI score, final teacher score, timestamp, teacher ID), attempt resets/re-opens (actor, reason, prior status), violation flags, and blocked login / session-conflict events. Admins have read access to the full audit trail.

## 12. User Flows
- **Student login:** roll number + access code → roster/eligibility check → session-conflict check (block newcomer if a session is active) → entry-window check → exam access. Login problems route to the admin (§5.3).
- **Exam-taking:** open (server computes remaining time) → question navigation (with/without backtracking) → answers persisted server-side → violation tracking → submission (manual, timer auto-cutoff, or violation auto-close). Interrupted sessions can resume within the window (§4.10).
- **Post-exam:** grading (auto / AI-assisted / manual) → teacher review/override → results release → student review (with or without explanations per exam setting).

## Change Log (v1.2 → v1.3)
- **Auth/session (§5.2):** resolved to **block the new login** on conflict, preserving the active session; login problems routed to admin (§5.3). OTP explicitly deferred to a later version.
- **Architecture (§8.1):** resolved the Render-vs-direct-Supabase question — **Render owns all writes/authorization; frontend reads Supabase directly only for RLS-scoped Realtime.**
- **Data model (§9):** added.
- **Timer (§4.1):** added late-entry cutoff, UTC handling, and the per-write authoritative end-time check.
- **Roster overrides (§2.1):** defined `inherit`/`replace`/`extend` modes.
- **Attempts (§4.10):** added resume-on-interruption and admin reset semantics.
- **AI grading (§4.9):** reframed as a first-pass aid with disclosed failure modes; provider abstracted behind an interface (initially Gemini).
- **Configurable policies (§4.3, §4.7):** backtracking and violation severity are per-exam settings; UI reflects the actual policy, not a hardcoded one.
- **Roles (§3, §5.1):** teacher/admin auth via Supabase Auth specified; admin capabilities detailed.
- **Reporting (§6.2/§6.3):** export = CSV; answer explanations = per-exam toggle.
- **NFRs (§7):** added accessibility target and supported-browser baseline; noted Realtime scaling concern (§6.1).
