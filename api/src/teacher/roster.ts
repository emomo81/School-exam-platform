import type { Request, Response } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db.js";
import { badRequest } from "../http.js";
import { currentUser, requireCourseAccess } from "../middleware/auth.js";

const entrySchema = z.object({
  roll_number: z.string().trim().min(1).max(64),
  student_name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200).optional(),
});

/** GET /teacher/courses/:courseId/roster */
export async function listRoster(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction((client) => requireCourseAccess(client, user, req.params.courseId));
  const rows = await pool.query(
    `select id, roll_number, student_name, email, created_at
       from course_roster where course_id = $1 order by roll_number`,
    [req.params.courseId],
  );
  res.json({ roster: rows.rows });
}

const bulkSchema = z.object({ entries: z.array(entrySchema).min(1).max(5000) });

/** POST /teacher/courses/:courseId/roster — bulk upsert from a JSON array. */
export async function upsertRoster(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("Body must be { entries: [{ roll_number, student_name, email? }] }.");
  const count = await insertEntries(user, req.params.courseId, parsed.data.entries);
  res.status(201).json({ upserted: count });
}

/**
 * POST /teacher/courses/:courseId/roster/csv — bulk upsert from CSV text.
 * Header row required: roll_number,student_name,email (email optional).
 * Minimal parser: no support for quoted fields containing commas/newlines
 * (adequate for roster CSVs; revisit if richer CSVs are needed).
 */
export async function upsertRosterCsv(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const csv = typeof req.body === "string" ? req.body : (req.body?.csv as string | undefined);
  if (!csv || !csv.trim()) throw badRequest("Send CSV text (Content-Type: text/csv) or { csv: \"...\" }.");

  const entries = parseRosterCsv(csv);
  if (entries.length === 0) throw badRequest("No data rows found in CSV.");
  const count = await insertEntries(user, req.params.courseId, entries);
  res.status(201).json({ upserted: count });
}

/** DELETE /teacher/courses/:courseId/roster/:rollNumber */
export async function removeRosterEntry(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction(async (client) => {
    await requireCourseAccess(client, user, req.params.courseId);
    await client.query(
      `delete from course_roster where course_id = $1 and roll_number = $2`,
      [req.params.courseId, req.params.rollNumber],
    );
  });
  res.json({ status: "removed" });
}

async function insertEntries(
  user: ReturnType<typeof currentUser>,
  courseId: string,
  entries: z.infer<typeof entrySchema>[],
): Promise<number> {
  return withTransaction(async (client) => {
    await requireCourseAccess(client, user, courseId);
    let upserted = 0;
    for (const e of entries) {
      const r = await client.query(
        `insert into course_roster (course_id, roll_number, student_name, email)
         values ($1, $2, $3, $4)
         on conflict (course_id, roll_number)
           do update set student_name = excluded.student_name, email = excluded.email`,
        [courseId, e.roll_number, e.student_name, e.email ?? null],
      );
      upserted += r.rowCount ?? 0;
    }
    return upserted;
  });
}

function parseRosterCsv(csv: string): z.infer<typeof entrySchema>[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = {
    roll: header.indexOf("roll_number"),
    name: header.indexOf("student_name"),
    email: header.indexOf("email"),
  };
  if (idx.roll === -1 || idx.name === -1) {
    throw badRequest("CSV header must include roll_number and student_name.");
  }
  const out: z.infer<typeof entrySchema>[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim());
    const parsed = entrySchema.safeParse({
      roll_number: cols[idx.roll],
      student_name: cols[idx.name],
      email: idx.email !== -1 && cols[idx.email] ? cols[idx.email] : undefined,
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
