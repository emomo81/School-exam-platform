import type { Request, Response } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db.js";
import { badRequest, notFound } from "../http.js";
import { currentUser, requireCourseAccess } from "../middleware/auth.js";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  term: z.string().trim().max(100).optional(),
});

/** POST /teacher/courses — create a course; the creator becomes primary teacher. */
export async function createCourse(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("name is required.");
  const { name, term } = parsed.data;

  const course = await withTransaction(async (client) => {
    const created = await client.query(
      `insert into courses (institution_id, name, term, primary_teacher_id)
       values ($1, $2, $3, $4)
       returning id, name, term, created_at`,
      [user.institution_id, name, term ?? null, user.id],
    );
    const row = created.rows[0];
    await client.query(
      `insert into course_teachers (course_id, user_id, role) values ($1, $2, 'primary')`,
      [row.id, user.id],
    );
    return row;
  });

  res.status(201).json({ course });
}

/** GET /teacher/courses — courses the user teaches (admins: all in their institution). */
export async function listCourses(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const result =
    user.role === "admin"
      ? await pool.query(
          `select id, name, term, primary_teacher_id, created_at
             from courses where institution_id = $1 order by created_at desc`,
          [user.institution_id],
        )
      : await pool.query(
          `select c.id, c.name, c.term, c.primary_teacher_id, c.created_at
             from courses c
             join course_teachers ct on ct.course_id = c.id
            where ct.user_id = $1
            order by c.created_at desc`,
          [user.id],
        );
  res.json({ courses: result.rows });
}

/** GET /teacher/courses/:courseId */
export async function getCourse(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const course = await withTransaction((client) =>
    requireCourseAccess(client, user, req.params.courseId),
  );
  const teachers = await pool.query(
    `select ct.user_id, ct.role, u.email
       from course_teachers ct join users u on u.id = ct.user_id
      where ct.course_id = $1`,
    [course.id],
  );
  res.json({ course, teachers: teachers.rows });
}

const addTeacherSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(["primary", "co"]).default("co"),
});

/** POST /teacher/courses/:courseId/teachers — add a co-teacher/TA (primary or admin only). */
export async function addCourseTeacher(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = addTeacherSchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("user_id (uuid) is required.");

  await withTransaction(async (client) => {
    const course = await requireCourseAccess(client, user, req.params.courseId);
    // Only the primary teacher or an admin may change the teaching roster.
    if (user.role !== "admin" && course.primary_teacher_id !== user.id) {
      throw badRequest("Only the primary teacher or an admin can add teachers.");
    }
    // The new teacher must be a real user in the same institution.
    const target = await client.query(
      `select 1 from users where id = $1 and institution_id = $2`,
      [parsed.data.user_id, user.institution_id],
    );
    if (target.rowCount === 0) throw notFound("Target user not found in this institution.");

    await client.query(
      `insert into course_teachers (course_id, user_id, role)
       values ($1, $2, $3)
       on conflict (course_id, user_id) do update set role = excluded.role`,
      [req.params.courseId, parsed.data.user_id, parsed.data.role],
    );
  });

  res.status(201).json({ status: "added" });
}
