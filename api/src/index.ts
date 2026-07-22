import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./env.js";
import { authRouter } from "./auth/router.js";
import { teacherRouter } from "./teacher/router.js";
import { errorHandler } from "./http.js";

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy; needed for correct req.ip
app.use(express.json());
app.use(cookieParser());

// Health check — proves the Render service is up (Phase 0 exit criterion).
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api", time: new Date().toISOString() });
});

// Student auth (AUTH-SPEC): /auth/student/login | /refresh | /submit
app.use("/auth", authRouter);

// Teacher/admin CRUD (Phase 2): courses, roster, exams, questions
app.use("/teacher", teacherRouter);

// Central error handler — must be registered after routes.
app.use(errorHandler);

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`api listening on :${env.port} (${env.nodeEnv})`);
});
