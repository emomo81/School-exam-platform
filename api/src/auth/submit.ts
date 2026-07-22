import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { withTransaction } from "../db.js";
import { env } from "../env.js";
import type { SessionClaims } from "../jwt.js";

/**
 * POST /auth/student/submit   (Authorization: Bearer <access token>)
 * Marks the attempt submitted and frees the active-session slot (AUTH-SPEC §5).
 * NOTE: grading/answer-finalisation is Phase 3/6 — this only closes the session.
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
    const payload = jwt.verify(header.slice(7), env.supabaseJwtSecret, {
      algorithms: ["HS256"],
    }) as jwt.JwtPayload;
    if (payload.typ !== "access") return null;
    return {
      sub: String(payload.sub),
      roll_number: String(payload.roll_number),
      exam_id: String(payload.exam_id),
      session_token_id: String(payload.session_token_id),
    };
  } catch {
    return null;
  }
}
