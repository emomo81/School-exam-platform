import express from "express";
import { env } from "./env.js";

const app = express();
app.use(express.json());

// Health check — proves the Render service is up (Phase 0 exit criterion).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api", time: new Date().toISOString() });
});

// Student auth routes (AUTH-SPEC) land here in Phase 1:
//   POST /auth/student/login
//   POST /auth/student/refresh
//   POST /auth/student/submit

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on :${env.port} (${env.nodeEnv})`);
});
