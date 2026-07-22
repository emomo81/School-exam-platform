import { Router } from "express";
import { asyncHandler } from "../http.js";
import { requireStudent } from "../middleware/student.js";
import { getExamState } from "./state.js";
import { saveAnswer } from "./answers.js";
import { studentSubmit } from "../auth/submit.js";

export const examRouter = Router();

// The student exam-taking runtime (Phase 3). All routes require the access token.
examRouter.use(requireStudent);

examRouter.get("/state", asyncHandler(getExamState));
examRouter.put("/answers/:questionId", asyncHandler(saveAnswer));
examRouter.post("/submit", asyncHandler(studentSubmit)); // manual submit (also at /auth/student/submit)
