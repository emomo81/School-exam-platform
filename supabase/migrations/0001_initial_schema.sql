-- =============================================================================
-- Exam Platform — initial schema (PRD v1.3 §9)
-- Postgres / Supabase. All timestamps are stored in UTC (timestamptz).
--
-- Authorization model (PRD §8.1): Render owns all writes and holds the
-- service-role key. The frontend reads directly from Supabase ONLY for
-- RLS-scoped Realtime subscriptions. Student sessions carry a custom JWT with
-- claims `roll_number` and `exam_id`; the policies below use those claims.
-- RLS here is defense-in-depth, not the primary gate.
-- =============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_cron;     -- timer sweeper (Phase 3)

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type user_role          as enum ('teacher', 'admin');
create type course_teacher_role as enum ('primary', 'co');
create type roster_mode        as enum ('inherit', 'replace', 'extend');
create type exam_status        as enum ('draft', 'scheduled', 'live', 'closed');
create type question_type      as enum ('mcq', 'essay');
create type question_source    as enum ('manual', 'ai');
create type review_status      as enum ('pending', 'approved');
create type violation_policy   as enum ('warn', 'warn_limit', 'zero_tolerance');
create type attempt_status     as enum (
  'in_progress', 'submitted', 'auto_submitted_timer',
  'auto_submitted_violation', 'reset'
);
create type essay_grade_status as enum ('pending', 'confirmed', 'overridden');

-- ---------------------------------------------------------------------------
-- Helper: current student claims from the JWT (set by Render-issued token)
-- ---------------------------------------------------------------------------
create or replace function current_roll_number() returns text
  language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'roll_number', '')
$$;

create or replace function current_claim_exam_id() returns uuid
  language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'exam_id', '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- Institutions & users (teachers/admins backed by Supabase Auth)
-- ---------------------------------------------------------------------------
create table institutions (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table users (
  id             uuid primary key,               -- matches auth.users.id
  institution_id uuid not null references institutions(id) on delete restrict,
  role           user_role not null,
  email          text not null unique,
  created_at     timestamptz not null default now()
);
create index on users (institution_id);

-- ---------------------------------------------------------------------------
-- Courses, teachers, roster
-- ---------------------------------------------------------------------------
create table courses (
  id                 uuid primary key default gen_random_uuid(),
  institution_id     uuid not null references institutions(id) on delete restrict,
  name               text not null,
  term               text,
  primary_teacher_id uuid not null references users(id) on delete restrict,
  created_at         timestamptz not null default now()
);
create index on courses (institution_id);

create table course_teachers (
  course_id uuid not null references courses(id) on delete cascade,
  user_id   uuid not null references users(id)   on delete cascade,
  role      course_teacher_role not null default 'co',
  primary key (course_id, user_id)
);

create table course_roster (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid not null references courses(id) on delete cascade,
  roll_number  text not null,
  student_name text not null,
  email        text,
  created_at   timestamptz not null default now(),
  unique (course_id, roll_number)
);
create index on course_roster (course_id);

-- ---------------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------------
create table exams (
  id                   uuid primary key default gen_random_uuid(),
  course_id            uuid not null references courses(id) on delete cascade,
  title                text not null,
  subject              text,
  start_at             timestamptz not null,
  end_at               timestamptz not null,
  no_entry_after       timestamptz not null,
  timezone             text not null default 'UTC',
  duration_minutes     integer not null check (duration_minutes > 0),
  access_code          text not null,
  roster_mode          roster_mode not null default 'inherit',
  backtracking_allowed boolean not null default true,
  violation_policy     violation_policy not null default 'warn',
  strike_limit         integer not null default 3 check (strike_limit >= 1),
  show_explanations    boolean not null default false,
  passing_pct          numeric(5,2) not null default 50 check (passing_pct between 0 and 100),
  total_marks          integer not null default 0,
  status               exam_status not null default 'draft',
  created_at           timestamptz not null default now(),
  check (end_at > start_at),
  check (no_entry_after <= end_at)
);
create index on exams (course_id);
create index on exams (status, end_at);   -- pg_cron sweeper scan

create table exam_roster_overrides (
  exam_id     uuid not null references exams(id) on delete cascade,
  roll_number text not null,
  primary key (exam_id, roll_number)
);

-- ---------------------------------------------------------------------------
-- Questions & options
-- ---------------------------------------------------------------------------
create table questions (
  id            uuid primary key default gen_random_uuid(),
  exam_id       uuid not null references exams(id) on delete cascade,
  type          question_type not null,
  body          text not null,
  marks         integer not null default 1 check (marks >= 0),
  model_answer  text,                              -- essay only
  source        question_source not null default 'manual',
  review_status review_status not null default 'approved',  -- AI drafts start 'pending'
  position      integer,
  created_at    timestamptz not null default now()
);
create index on questions (exam_id);

create table question_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  label       text not null,
  is_correct  boolean not null default false,
  position    integer
);
create index on question_options (question_id);

-- ---------------------------------------------------------------------------
-- Attempts, answers, violations
-- ---------------------------------------------------------------------------
create table attempts (
  id                        uuid primary key default gen_random_uuid(),
  exam_id                   uuid not null references exams(id) on delete cascade,
  roll_number               text not null,
  status                    attempt_status not null default 'in_progress',
  opened_at                 timestamptz not null default now(),
  submitted_at              timestamptz,
  remaining_seconds_snapshot integer,
  score                     numeric(7,2),
  unique (exam_id, roll_number)          -- one attempt per exam per student
);
create index on attempts (exam_id, status);

create table attempt_answers (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references attempts(id) on delete cascade,
  question_id   uuid not null references questions(id) on delete cascade,
  answer        jsonb,                    -- selected option id(s) or essay text
  is_correct    boolean,
  awarded_marks numeric(7,2),
  updated_at    timestamptz not null default now(),
  unique (attempt_id, question_id)
);
create index on attempt_answers (attempt_id);

create table violations (
  id            uuid primary key default gen_random_uuid(),
  attempt_id    uuid not null references attempts(id) on delete cascade,
  type          text not null,            -- 'tab_blur' | 'fullscreen_exit' | 'screenshot' | ...
  strike_number integer not null,
  occurred_at   timestamptz not null default now()
);
create index on violations (attempt_id);

-- ---------------------------------------------------------------------------
-- Essay grading (AI first-pass + teacher confirmation)
-- ---------------------------------------------------------------------------
create table essay_grades (
  id                uuid primary key default gen_random_uuid(),
  attempt_answer_id uuid not null references attempt_answers(id) on delete cascade,
  ai_suggested_score numeric(7,2),
  ai_rationale      text,
  final_score       numeric(7,2),
  status            essay_grade_status not null default 'pending',
  graded_by         uuid references users(id),
  graded_at         timestamptz,
  unique (attempt_answer_id)
);

-- ---------------------------------------------------------------------------
-- Single active session enforcement (PRD §5.2)
-- ---------------------------------------------------------------------------
create table active_sessions (
  roll_number      text not null,
  exam_id          uuid not null references exams(id) on delete cascade,
  session_token_id text not null,
  opened_at        timestamptz not null default now(),
  primary key (roll_number, exam_id)     -- second concurrent login is blocked on conflict
);

-- ---------------------------------------------------------------------------
-- Audit log (PRD §11)
-- ---------------------------------------------------------------------------
create table audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,                       -- null for system actions
  actor_role  text,
  action      text not null,              -- 'grade_override' | 'attempt_reset' | 'login_conflict' | ...
  entity      text not null,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  reason      text,
  occurred_at timestamptz not null default now()
);
create index on audit_logs (entity, entity_id);
create index on audit_logs (occurred_at);

-- =============================================================================
-- Row Level Security
-- Render uses the service-role key (bypasses RLS) for all writes. Policies
-- below scope what a STUDENT JWT can read directly via Realtime. Teacher/admin
-- data is not exposed to anon/student roles at all.
-- =============================================================================
alter table institutions          enable row level security;
alter table users                 enable row level security;
alter table courses               enable row level security;
alter table course_teachers       enable row level security;
alter table course_roster         enable row level security;
alter table exams                 enable row level security;
alter table exam_roster_overrides enable row level security;
alter table questions             enable row level security;
alter table question_options      enable row level security;
alter table attempts              enable row level security;
alter table attempt_answers       enable row level security;
alter table violations            enable row level security;
alter table essay_grades          enable row level security;
alter table active_sessions       enable row level security;
alter table audit_logs            enable row level security;

-- Student read policies: a session may only see its own attempt for the exam
-- named in its JWT. (Writes go through Render, which bypasses RLS.)
create policy student_reads_own_attempt on attempts
  for select to authenticated
  using (roll_number = current_roll_number() and exam_id = current_claim_exam_id());

create policy student_reads_own_answers on attempt_answers
  for select to authenticated
  using (exists (
    select 1 from attempts a
    where a.id = attempt_answers.attempt_id
      and a.roll_number = current_roll_number()
      and a.exam_id = current_claim_exam_id()
  ));

create policy student_reads_own_violations on violations
  for select to authenticated
  using (exists (
    select 1 from attempts a
    where a.id = violations.attempt_id
      and a.roll_number = current_roll_number()
      and a.exam_id = current_claim_exam_id()
  ));

-- NOTE: Teacher/admin dashboard reads are served by Render (service role) or by
-- authenticated Supabase Auth sessions with teacher-scoped policies added in a
-- later migration once the monitoring queries are finalized (Phase 5).
