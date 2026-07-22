import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTransaction } from "../db.js";
import { LoginFailure, sendGenericLoginFailure } from "../errors.js";
import { signAccessToken, signRefreshToken, type SessionClaims } from "../jwt.js";
import { allowLoginAttempt } from "../rateLimit.js";
import { env } from "../env.js";

const bodySchema = z.object({
  roll_number: z.string().trim().min(1).max(64),
  access_code: z.string().trim().min(1).max(128),
});

const TERMINAL_STATUSES = [
  "submitted",
  "auto_submitted_timer",
  "auto_submitted_violation",
];

/**
 * POST /auth/student/login   { roll_number, access_code }
 * Implements AUTH-SPEC §2. All failures return the single generic error.
 */
export async function studentLogin(req: Request, res: Response): Promise<void> {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return sendGenericLoginFailure(res);
  const { roll_number, access_code } = parsed.data;

  // Rate-limit by IP + roll number (AUTH-SPEC §6).
  const rlKey = `${req.ip}:${roll_number}`;
  if (!allowLoginAttempt(rlKey)) {
    res.status(429).json({ error: "rate_limited", message: "Too many attempts. Try again shortly." });
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      // 1. Resolve exam by access code (unique; only scheduled/live are enterable).
      const examRes = await client.query(
        `select id, course_id, title, subject, start_at, end_at, no_entry_after,
                timezone, duration_minutes, backtracking_allowed, roster_mode,
                total_marks, passing_pct
           from exams
          where access_code = $1 and status in ('scheduled', 'live')`,
        [access_code],
      );
      if (examRes.rowCount === 0) throw new LoginFailure("no_exam_for_code");
      const exam = examRes.rows[0];

      // 2. Entry-window check.
      const now = new Date();
      if (now < new Date(exam.start_at)) throw new LoginFailure("before_start");
      if (now > new Date(exam.no_entry_after)) throw new LoginFailure("after_entry_cutoff");

      // 3. Eligibility (roster mode).
      const eligible = await isEligible(client, exam, roll_number);
      if (!eligible) throw new LoginFailure("not_on_roster");

      // 4. Existing attempt: terminal → over for this student (no session claimed yet).
      const attemptRes = await client.query(
        `select id, status from attempts where exam_id = $1 and roll_number = $2`,
        [exam.id, roll_number],
      );
      const existingAttempt = attemptRes.rows[0];
      if (existingAttempt && TERMINAL_STATUSES.includes(existingAttempt.status)) {
        throw new LoginFailure("attempt_terminal");
      }

      // 5. Atomic single-session claim (AUTH-SPEC §4).
      const sessionTokenId = randomUUID();
      const claimRes = await client.query(
        `insert into active_sessions (roll_number, exam_id, session_token_id)
         values ($1, $2, $3)
         on conflict (roll_number, exam_id) do nothing
         returning session_token_id`,
        [roll_number, exam.id, sessionTokenId],
      );
      if (claimRes.rowCount === 0) {
        // A session is already live for this student → block the newcomer, log it.
        await client.query(
          `insert into audit_logs (actor_role, action, entity, entity_id, after)
           values ('student', 'login_conflict', 'exam', $1, $2)`,
          [exam.id, JSON.stringify({ roll_number, ip: req.ip })],
        );
        throw new LoginFailure("session_conflict");
      }

      // 6. Bootstrap or resume the attempt.
      let attemptId: string;
      if (existingAttempt) {
        attemptId = existingAttempt.id; // in_progress → resume
      } else {
        const created = await client.query(
          `insert into attempts (exam_id, roll_number, status)
           values ($1, $2, 'in_progress') returning id`,
          [exam.id, roll_number],
        );
        attemptId = created.rows[0].id;
      }

      return { exam, attemptId, sessionTokenId };
    });

    // 7. Issue tokens; remaining time is computed server-side (never trust client).
    const { exam, attemptId, sessionTokenId } = result;
    const endAtMs = new Date(exam.end_at).getTime();
    const claims: SessionClaims = {
      sub: attemptId,
      roll_number,
      exam_id: exam.id,
      session_token_id: sessionTokenId,
    };
    const accessToken = signAccessToken(claims, endAtMs);
    const refreshToken = signRefreshToken(claims, endAtMs);

    res.cookie("student_refresh", refreshToken, {
      httpOnly: true,
      secure: env.isProd,
      sameSite: "strict",
      path: "/auth/student",
      maxAge: Math.max(0, endAtMs - Date.now()),
    });

    res.json({
      access_token: accessToken,
      remaining_seconds: Math.max(0, Math.floor((endAtMs - Date.now()) / 1000)),
      exam: {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        end_at: exam.end_at,
        timezone: exam.timezone,
        duration_minutes: exam.duration_minutes,
        backtracking_allowed: exam.backtracking_allowed,
        total_marks: exam.total_marks,
        passing_pct: exam.passing_pct,
      },
    });
  } catch (err) {
    if (err instanceof LoginFailure) {
      // Internal reason logged server-side only; client gets the generic error.
      // eslint-disable-next-line no-console
      console.info(`login_failed reason=${err.internalReason} roll=${roll_number}`);
      return sendGenericLoginFailure(res);
    }
    // eslint-disable-next-line no-console
    console.error("login_error", err);
    res.status(500).json({ error: "server_error", message: "Something went wrong." });
  }
}

async function isEligible(
  client: import("pg").PoolClient,
  exam: { id: string; course_id: string; roster_mode: string },
  rollNumber: string,
): Promise<boolean> {
  const inCourse = async () =>
    (
      await client.query(
        `select 1 from course_roster where course_id = $1 and roll_number = $2`,
        [exam.course_id, rollNumber],
      )
    ).rowCount! > 0;

  const inOverride = async () =>
    (
      await client.query(
        `select 1 from exam_roster_overrides where exam_id = $1 and roll_number = $2`,
        [exam.id, rollNumber],
      )
    ).rowCount! > 0;

  switch (exam.roster_mode) {
    case "inherit":
      return inCourse();
    case "replace":
      return inOverride();
    case "extend":
      return (await inCourse()) || (await inOverride());
    default:
      return false;
  }
}
