import type { Request, Response } from "express";
import { withTransaction } from "../db.js";
import { verifyAccessToken, type SessionClaims } from "../jwt.js";

/**
 * POST /auth/student/submit   (Authorization: Bearer <access token>)
 * Marks the attempt submitted and frees the active-session slot (AUTH-SPEC §5).
 * NOTE: MCQ auto-grading is Phase 6 — this only closes the attempt + session.
 */
export async function studentSubmit(req: Request, res: Response): Promise<void> {
  const claims = readAccessToken(req);
  if (!claims) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing token." });
    return;
  }

  await withTransaction(async (client) => {
    // Only an in-progress attempt can be submitted here; terminal ones are left as-is.
    await client.query(
      `update attempts
          set status = 'submitted', submitted_at = now()
        where id = $1 and status = 'in_progress'`,
      [claims.sub],
    );
    // Free the single-session slot so a re-login is not needed to see results.
    await client.query(
      `delete from active_sessions
        where roll_number = $1 and exam_id = $2 and session_token_id = $3`,
      [claims.roll_number, claims.exam_id, claims.session_token_id],
    );
  });

  res.clearCookie("student_refresh", { path: "/auth/student" });
  res.json({ status: "submitted" });
}

function readAccessToken(req: Request): SessionClaims | null {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  try {
    return verifyAccessToken(header.slice(7));
  } catch {
    return null;
  }
}
