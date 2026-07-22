-- =============================================================================
-- 0002 — enforce unambiguous exam access-code lookup
-- Ref: AUTH-SPEC §2 step 1 and §8 open item #1.
--
-- Student login resolves the exam by access_code alone, so the lookup must be
-- unambiguous. A global unique constraint guarantees that. Trade-off: an access
-- code cannot be reused across historical exams — always generate a fresh code
-- per exam (which is the intended workflow anyway).
-- =============================================================================
alter table exams
  add constraint exams_access_code_key unique (access_code);
