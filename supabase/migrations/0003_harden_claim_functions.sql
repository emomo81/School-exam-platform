-- =============================================================================
-- 0003 — harden the JWT-claim helper functions
-- Ref: Supabase linter 0011 (function_search_path_mutable).
--
-- These functions run inside RLS policies, so pin an empty search_path to
-- prevent search_path-injection. They only call built-ins (current_setting,
-- jsonb operators) which live in pg_catalog and remain resolvable.
-- =============================================================================
alter function current_roll_number()  set search_path = '';
alter function current_claim_exam_id() set search_path = '';
