import { Router } from "express";
import { studentLogin } from "./login.js";
import { studentRefresh } from "./refresh.js";
import { studentSubmit } from "./submit.js";

export const authRouter = Router();

// Student auth (AUTH-SPEC). Mounted at /auth/student.
authRouter.post("/student/login", studentLogin);
authRouter.post("/student/refresh", studentRefresh);
authRouter.post("/student/submit", studentSubmit);
