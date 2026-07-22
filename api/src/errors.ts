import type { Response } from "express";

/**
 * Single generic login failure (AUTH-SPEC §6, anti-enumeration).
 * Every login/eligibility/window/conflict failure returns the SAME response so
 * an attacker cannot learn whether a roll number exists, whether the code was
 * right, or which check failed. The real reason is logged server-side only.
 */
export class LoginFailure extends Error {
  constructor(public readonly internalReason: string) {
    super(internalReason);
    this.name = "LoginFailure";
  }
}

export function sendGenericLoginFailure(res: Response): void {
  res.status(401).json({
    error: "login_failed",
    message: "Unable to start the exam. Contact your admin/invigilator.",
  });
}
