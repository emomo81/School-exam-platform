import type { Request, Response, NextFunction } from "express";
import type { PoolClient } from "pg";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { env } from "../env.js";
import { forbidden, notFound } from "../http.js";

export interface AuthUser {
  id: string;
  role: "teacher" | "admin";
  institution_id: string;
  email: string;
}

// Attach the authenticated teacher/admin to the request.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Verifies a Supabase Auth JWT (HS256 with the project secret) and loads the
 * matching public.users row. Teacher/admin accounts are provisioned by an admin
 * (Phase 8); this middleware assumes the users row already exists.
 *
 * Student tokens are also signed with this secret but carry `typ` and have no
 * users row, so they are rejected here.
 */
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "Missing bearer token." });
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), env.supabaseJwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
  } catch {
    res.status(401).json({ error: "unauthorized", message: "Invalid token." });
    return;
  }

  // Reject our own student tokens outright (they carry a typ claim).
  if (payload.typ === "access" || payload.typ === "refresh") {
    res.status(403).json({ error: "forbidden", message: "Not a teacher/admin token." });
    return;
  }

  const userRes = await pool.query(
    `select id, role, institution_id, email from users where id = $1`,
    [payload.sub],
  );
  if (userRes.rowCount === 0) {
    res.status(403).json({ error: "forbidden", message: "No teacher/admin account for this user." });
    return;
  }

  req.user = userRes.rows[0] as AuthUser;
  next();
}

/** The authenticated user, guaranteed present after requireUser. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw forbidden("Not authenticated.");
  return req.user;
}

/**
 * Loads a course and asserts the user may manage it: admins manage any course
 * in their institution; teachers manage courses they teach (primary or co).
 * Returns the course row. Throws 404/403 otherwise.
 */
export async function requireCourseAccess(
  client: PoolClient,
  user: AuthUser,
  courseId: string,
): Promise<{ id: string; institution_id: string; primary_teacher_id: string; name: string }> {
  const res = await client.query(
    `select id, institution_id, primary_teacher_id, name from courses where id = $1`,
    [courseId],
  );
  if (res.rowCount === 0) throw notFound("Course not found.");
  const course = res.rows[0];

  if (course.institution_id !== user.institution_id) throw notFound("Course not found.");
  if (user.role === "admin") return course;

  const teaches = await client.query(
    `select 1 from course_teachers where course_id = $1 and user_id = $2`,
    [courseId, user.id],
  );
  if (teaches.rowCount === 0) throw forbidden("You do not teach this course.");
  return course;
}

/** Resolves an exam to its course and asserts the user may manage that course. */
export async function requireExamAccess(
  client: PoolClient,
  user: AuthUser,
  examId: string,
): Promise<{ examId: string; courseId: string }> {
  const res = await client.query(`select course_id from exams where id = $1`, [examId]);
  if (res.rowCount === 0) throw notFound("Exam not found.");
  await requireCourseAccess(client, user, res.rows[0].course_id);
  return { examId, courseId: res.rows[0].course_id };
}
