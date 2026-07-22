import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken, type SessionClaims } from "../jwt.js";

// The authenticated student attempt (from the access token), set by requireStudent.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      attempt?: SessionClaims;
    }
  }
}

/** Verifies the student access token and attaches the attempt claims. */
export function requireStudent(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "Missing bearer token." });
    return;
  }
  try {
    req.attempt = verifyAccessToken(header.slice(7));
  } catch {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired token." });
    return;
  }
  next();
}

/** The current student attempt claims, guaranteed present after requireStudent. */
export function currentAttempt(req: Request): SessionClaims {
  if (!req.attempt) throw new Error("requireStudent middleware not applied");
  return req.attempt;
}
