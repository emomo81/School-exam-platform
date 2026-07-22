# Custom Student Auth — Design Spec

Covers the security-critical piece from PRD §5, §8.1: how a student proves eligibility with **roll number + exam access code** and gets a scoped, short-lived session that Supabase RLS trusts. Teachers/admins use Supabase Auth (email/password) and are out of scope here except where they intersect (resets, conflict resolution).

**Guiding rule:** Render is the only writer and the authoritative gate. The student's Supabase JWT grants *read-only, self-scoped* Realtime access — never write access.

---

## 1. Actors & trust boundaries
- **Browser (student):** untrusted. Holds only a short-lived access token + httpOnly refresh cookie.
- **Render API:** trusted. Holds the Supabase **service-role key** and the JWT **signing secret**. Performs every eligibility/timing/write decision.
- **Supabase Postgres:** trusts JWTs signed with the shared secret; RLS scopes student reads by claims. Render's service role bypasses RLS.

The JWT signing secret **must be the same secret Supabase uses to verify JWTs** (Supabase project JWT secret), so Supabase validates Render-issued tokens natively. Keep it only in Render env + Supabase config.

---

## 2. Login flow

```
POST /auth/student/login   { roll_number, access_code }
```

Render performs, in order (all failures return the SAME generic error — see §6):

1. **Find exam by access code.** Look up the exam whose `access_code` matches. (Access code is per-exam, PRD §5.2.) If none → fail.
2. **Entry window check.** `now()` must be ≥ `start_at` and ≤ `no_entry_after`. Outside → fail (distinct internal reason, generic external message).
3. **Eligibility check.** Resolve the applicable roster by `roster_mode`:
   - `inherit` → `roll_number` ∈ `course_roster` for the exam's course.
   - `replace` → `roll_number` ∈ `exam_roster_overrides` only.
   - `extend`  → `roll_number` ∈ (`course_roster` ∪ `exam_roster_overrides`).
   Not eligible → fail.
4. **Session-conflict check (single active session, PRD §5.2).**
   - Attempt to claim `active_sessions (roll_number, exam_id)`.
   - If a live row already exists for this pair → **block this new login**, write an `audit_logs` row (`action = 'login_conflict'`), and return the generic error. The existing session is untouched.
   - Claiming is atomic (see §4) so two simultaneous logins can't both win.
5. **Attempt bootstrap.** Create the `attempts` row if absent (`status = in_progress`), or load the existing one for resume (PRD §4.10). If the existing attempt is terminal (`submitted` / `auto_submitted_*`) → fail: the exam is over for this student (only an admin/teacher reset re-opens it).
6. **Issue tokens** (§3) and return remaining time computed server-side.

On success the response contains the access token, the exam's public metadata, and `remaining_seconds` = `end_at − now()` (never trust the client clock).

---

## 3. Token design

Two tokens:

- **Access token (JWT, ~10 min TTL):** signed with the Supabase JWT secret (HS256). Sent to the browser; used both as the `Authorization: Bearer` to Render and as the Supabase client token for Realtime reads.
  Claims:
  ```json
  {
    "sub": "<attempt_id>",
    "role": "authenticated",
    "roll_number": "20231145",
    "exam_id": "<uuid>",
    "session_token_id": "<uuid>",
    "exp": 1690000000
  }
  ```
  `roll_number` + `exam_id` are what the RLS helpers in migration `0001` read. `role: "authenticated"` matches the `to authenticated` policies.
- **Refresh token (opaque, httpOnly + Secure + SameSite=Strict cookie, TTL = exam window):** stored server-side (hash) and bound to `session_token_id`. Used only against `POST /auth/student/refresh`. Never readable by JS.

**Why short access TTL:** limits the blast radius of a leaked token and forces a refresh that re-checks the session is still the active one (a token whose `session_token_id` no longer matches `active_sessions` is refused — this is how an admin "clear session" instantly locks out a bad actor).

---

## 4. Concurrency & the single-session guarantee
The conflict check must be race-free. Enforce at the DB, not in app logic:

- `active_sessions` PK is `(roll_number, exam_id)` (migration `0001`). The claim is a single statement:
  ```sql
  insert into active_sessions (roll_number, exam_id, session_token_id)
  values ($1, $2, $3)
  on conflict (roll_number, exam_id) do nothing
  returning session_token_id;
  ```
  Zero rows returned ⇒ a session already exists ⇒ **block** (step 4). This is atomic under concurrent logins; exactly one caller wins.
- **Admin "clear session"** deletes the `active_sessions` row (and rotates so the old token's `session_token_id` no longer matches). The next refresh by the old holder fails; the student can then log in fresh (PRD §5.3).

---

## 5. Refresh & logout
- `POST /auth/student/refresh` (cookie): verify refresh token → confirm `session_token_id` still matches `active_sessions` → confirm exam not past `end_at` → issue a new access token. Any mismatch → 401 and clear cookie.
- `POST /auth/student/submit` or timer/violation auto-submit → mark attempt terminal and **delete the `active_sessions` row** so the slot frees.
- No idle logout beyond access-token expiry; the exam window is the natural bound.

---

## 6. Error handling (anti-enumeration)
All login failures (bad code, wrong exam, not on roster, outside window, session conflict, terminal attempt) return **one identical response**:
```
401  { "error": "login_failed", "message": "Unable to start the exam. Contact your admin/invigilator." }
```
- Never reveal whether a roll number exists, whether the code was right, or which check failed. Internal reason is logged server-side only.
- This directs students to the §5.3 resolution path (contact admin) without leaking roster membership.
- **Rate-limit** by IP + roll_number (e.g. token bucket) to blunt access-code guessing, since the code is the master credential.

---

## 7. What RLS does NOT cover (must live in Render)
RLS only scopes student *reads*. These are Render's job and must never be assumed from the token alone:
- Rejecting **answer writes after `end_at`** (per-write authoritative check, PRD §4.1).
- Enforcing **backtracking** rules and one-attempt semantics.
- Violation escalation / auto-submit.
- Any teacher/admin action.

---

## 8. Open items
1. **Access-code uniqueness** — ✅ RESOLVED. Global `unique` constraint on `exams.access_code` added in migration `0002`; the login lookup is now unambiguous.
2. **JWT signing method** — ⚠️ CONFIRM. The code signs tokens HS256 with the project's legacy shared JWT secret (`SUPABASE_JWT_SECRET`), which Supabase Realtime verifies natively. Newer Supabase projects may default to **asymmetric JWT signing keys**; if Realtime rejects the minted tokens, switch to the project's signing key. Verify once Phase 5 (Realtime monitoring) is wired.
3. **Realtime role** — the implementation assumes students connect to Supabase as `authenticated` (access token carries `role: "authenticated"`, matching the `to authenticated` RLS policies in `0001`). Change both together if you prefer `anon`.
4. **Refresh token store** — ✅ RESOLVED without a store. The refresh token is a JWT bound to `session_token_id`; revocation is enforced by matching it against `active_sessions` on every refresh, so an admin "clear session" invalidates it immediately. No Redis/table needed for auth (Phase 7 Redis is still used for the AI queue).
