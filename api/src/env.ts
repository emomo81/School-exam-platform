// Centralised env access for the Render API service.
// These are server-only secrets — they must NEVER be exposed to the frontend.
//
// Load api/.env before reading anything. Imported first so process.env is
// populated regardless of entry point. In production (Render) the platform
// injects env vars directly and no .env file is present, which is fine.
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail fast on boot rather than at first request.
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  port: Number(optional("PORT", "8080")),
  nodeEnv: optional("NODE_ENV", "development"),
  isProd: optional("NODE_ENV", "development") === "production",

  // Direct Postgres connection string (Supabase → Project Settings → Database).
  // The API connects as the DB owner and performs all writes; RLS does not apply
  // to this connection (PRD §8.1). Keep it secret.
  databaseUrl: required("SUPABASE_DB_URL"),

  // Shared JWT secret: must equal the Supabase project's JWT secret so Supabase
  // Realtime verifies the student tokens Render mints (AUTH-SPEC §2/§3).
  supabaseJwtSecret: required("SUPABASE_JWT_SECRET"),

  // Access-token TTL (seconds). Short by design (AUTH-SPEC §3).
  accessTokenTtlSeconds: Number(optional("ACCESS_TOKEN_TTL_SECONDS", "600")),
} as const;

export type Env = typeof env;
