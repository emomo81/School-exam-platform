import type { Request, Response } from "express";
import { pool } from "../db.js";
import { signAccessToken, verifyRefreshToken, type SessionClaims } from "../jwt.js";

/**
 * POST /auth/student/refresh   (refresh cookie)
 * Re-checks the session is still the active one before minting a new access
 * token. A mismatch (e.g. admin cleared the session) → 401 (AUTH-SPEC §5).
 */
export async function studentRefresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.student_refresh as string | undefined;
  if (!token) return unauthorized(res);

  let claims: SessionClaims;
  try {
    claims = verifyRefreshToken(token);
  } catch {
    return unauthorized(res);
  }

  // Session must still exist with the SAME token id, and the exam not yet ended.
  const sessionRes = await pool.query(
    `select 1
       from active_sessions s
       join exams e on e.id = s.exam_id
      where s.roll_number = $1
        and s.exam_id = $2
        and s.session_token_id = $3
        and e.end_at > now()`,
    [claims.roll_number, claims.exam_id, claims.session_token_id],
  );
  if (sessionRes.rowCount === 0) return unauthorized(res);

  const examRes = await pool.query(`select end_at from exams where id = $1`, [claims.exam_id]);
  const endAtMs = new Date(examRes.rows[0].end_at).getTime();

  const accessToken = signAccessToken(claims, endAtMs);
  res.json({
    access_token: accessToken,
    remaining_seconds: Math.max(0, Math.floor((endAtMs - Date.now()) / 1000)),
  });
}

function unauthorized(res: Response): void {
  res.clearCookie("student_refresh", { path: "/auth/student" });
  res.status(401).json({ error: "unauthorized", message: "Session expired. Please log in again." });
}
