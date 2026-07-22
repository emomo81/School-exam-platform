// Centralised env access for the Render API service.
// These are server-only secrets — they must NEVER be exposed to the frontend.

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

  // Supabase — service role bypasses RLS; used for all writes (PRD §8.1).
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  // Shared JWT secret: must equal the Supabase project JWT secret so Supabase
  // verifies Render-issued student tokens natively (AUTH-SPEC §2).
  supabaseJwtSecret: required("SUPABASE_JWT_SECRET"),
};

export type Env = typeof env;
