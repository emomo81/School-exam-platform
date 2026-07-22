import jwt from "jsonwebtoken";
import { env } from "./env.js";

// Tokens are HS256-signed with the Supabase project's JWT secret so Supabase
// Realtime verifies them natively (AUTH-SPEC §3).
//
// NOTE / open item: this assumes the project uses the legacy shared HS256 JWT
// secret. Newer Supabase projects may default to asymmetric JWT signing keys;
// if Realtime rejects these tokens, switch to the project's signing key. See
// docs/AUTH-SPEC.md §8.

export interface SessionClaims {
  sub: string; // attempt_id
  roll_number: string;
  exam_id: string;
  session_token_id: string;
}

/** Short-lived token, also used as the Supabase Realtime token (role: authenticated). */
export function signAccessToken(claims: SessionClaims, examEndAtMs: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = Math.floor(examEndAtMs / 1000);
  // Never outlive the exam window.
  const exp = Math.min(nowSec + env.accessTokenTtlSeconds, endSec);
  return jwt.sign(
    { ...claims, role: "authenticated", typ: "access", iat: nowSec, exp },
    env.supabaseJwtSecret,
    { algorithm: "HS256" },
  );
}

/**
 * Refresh token — httpOnly cookie only, valid for the exam window. It carries
 * NO `authenticated` role, so even if presented to Supabase it grants no reads;
 * revocation is enforced by matching session_token_id against active_sessions
 * on refresh (AUTH-SPEC §4/§5), so no separate token store is needed.
 */
export function signRefreshToken(claims: SessionClaims, examEndAtMs: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = Math.floor(examEndAtMs / 1000);
  return jwt.sign(
    { ...claims, typ: "refresh", iat: nowSec, exp },
    env.supabaseJwtSecret,
    { algorithm: "HS256" },
  );
}

export function verifyRefreshToken(token: string): SessionClaims {
  const payload = jwt.verify(token, env.supabaseJwtSecret, {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;
  if (payload.typ !== "refresh") throw new Error("wrong token type");
  return {
    sub: String(payload.sub),
    roll_number: String(payload.roll_number),
    exam_id: String(payload.exam_id),
    session_token_id: String(payload.session_token_id),
  };
}
