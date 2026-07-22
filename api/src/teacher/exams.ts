import type { Request, Response } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db.js";
import { badRequest } from "../http.js";
import { currentUser, requireCourseAccess, requireExamAccess } from "../middleware/auth.js";

// Ambiguous characters (0/O, 1/I/L) removed so codes are easy to read/type.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEFAULT_GRACE_MINUTES = 30; // PRD §4.1 late-entry default

function generateAccessCode(length = 8): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    subject: z.string().trim().max(120).optional(),
    start_at: z.string().datetime(),
    duration_minutes: z.number().int().positive().max(24 * 60),
    no_entry_after: z.string().datetime().optional(),
    timezone: z.string().max(64).default("UTC"),
    backtracking_allowed: z.boolean().default(true),
    violation_policy: z.enum(["warn", "warn_limit", "zero_tolerance"]).default("warn"),
    strike_limit: z.number().int().min(1).max(20).default(3),
    show_explanations: z.boolean().default(false),
    passing_pct: z.number().min(0).max(100).default(50),
  })
  .strict();

/** POST /teacher/courses/:courseId/exams — create an exam (starts as draft). */
export async function createExam(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Invalid exam payload: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  }
  const d = parsed.data;

  const startAt = new Date(d.start_at);
  const endAt = new Date(startAt.getTime() + d.duration_minutes * 60_000);
  // Default no-entry cutoff = start + grace, capped at end.
  const noEntryAfter = d.no_entry_after
    ? new Date(d.no_entry_after)
    : new Date(Math.min(startAt.getTime() + DEFAULT_GRACE_MINUTES * 60_000, endAt.getTime()));
  if (noEntryAfter > endAt) throw badRequest("no_entry_after cannot be after the exam end time.");

  const exam = await withTransaction(async (client) => {
    await requireCourseAccess(client, user, req.params.courseId);
    // Retry a few times in case of an access_code collision (globally unique).
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const created = await client.query(
          `insert into exams
             (course_id, title, subject, start_at, end_at, no_entry_after, timezone,
              duration_minutes, access_code, backtracking_allowed, violation_policy,
              strike_limit, show_explanations, passing_pct, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft')
           returning *`,
          [
            req.params.courseId, d.title, d.subject ?? null, startAt, endAt, noEntryAfter,
            d.timezone, d.duration_minutes, generateAccessCode(), d.backtracking_allowed,
            d.violation_policy, d.strike_limit, d.show_explanations, d.passing_pct,
          ],
        );
        return created.rows[0];
      } catch (err) {
        if ((err as { code?: string }).code === "23505" && attempt < 4) continue; // unique_violation → retry
        throw err;
      }
    }
    throw badRequest("Could not generate a unique access code; please retry.");
  });

  res.status(201).json({ exam });
}

/** GET /teacher/courses/:courseId/exams */
export async function listExams(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction((client) => requireCourseAccess(client, user, req.params.courseId));
  const rows = await pool.query(
    `select id, title, subject, start_at, end_at, no_entry_after, status,
            access_code, total_marks, duration_minutes
       from exams where course_id = $1 order by start_at desc`,
    [req.params.courseId],
  );
  res.json({ exams: rows.rows });
}

/** GET /teacher/exams/:examId */
export async function getExam(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction((client) => requireExamAccess(client, user, req.params.examId));
  const exam = await pool.query(`select * from exams where id = $1`, [req.params.examId]);
  res.json({ exam: exam.rows[0] });
}

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    subject: z.string().trim().max(120).optional(),
    backtracking_allowed: z.boolean().optional(),
    violation_policy: z.enum(["warn", "warn_limit", "zero_tolerance"]).optional(),
    strike_limit: z.number().int().min(1).max(20).optional(),
    show_explanations: z.boolean().optional(),
    passing_pct: z.number().min(0).max(100).optional(),
    status: z.enum(["draft", "scheduled", "live", "closed"]).optional(),
  })
  .strict();

/** PATCH /teacher/exams/:examId — update config and/or publish (status). */
export async function updateExam(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("Invalid update payload.");
  const fields = parsed.data;
  const keys = Object.keys(fields);
  if (keys.length === 0) throw badRequest("No fields to update.");

  const exam = await withTransaction(async (client) => {
    await requireExamAccess(client, user, req.params.examId);
    const setSql = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) => (fields as Record<string, unknown>)[k]);
    const updated = await client.query(
      `update exams set ${setSql} where id = $1 returning *`,
      [req.params.examId, ...values],
    );
    return updated.rows[0];
  });

  res.json({ exam });
}
