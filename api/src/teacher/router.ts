import { Router } from "express";
import express from "express";
import { asyncHandler } from "../http.js";
import { requireUser } from "../middleware/auth.js";
import { addCourseTeacher, createCourse, getCourse, listCourses } from "./courses.js";
import { listRoster, removeRosterEntry, upsertRoster, upsertRosterCsv } from "./roster.js";
import { createExam, getExam, listExams, updateExam } from "./exams.js";
import { addQuestion, deleteQuestion, listQuestions } from "./questions.js";

export const teacherRouter = Router();

// Every teacher/admin route requires a valid Supabase Auth token + users row.
teacherRouter.use(requireUser);

// Courses
teacherRouter.post("/courses", asyncHandler(createCourse));
teacherRouter.get("/courses", asyncHandler(listCourses));
teacherRouter.get("/courses/:courseId", asyncHandler(getCourse));
teacherRouter.post("/courses/:courseId/teachers", asyncHandler(addCourseTeacher));

// Roster
teacherRouter.get("/courses/:courseId/roster", asyncHandler(listRoster));
teacherRouter.post("/courses/:courseId/roster", asyncHandler(upsertRoster));
teacherRouter.post(
  "/courses/:courseId/roster/csv",
  express.text({ type: ["text/csv", "text/plain"], limit: "2mb" }),
  asyncHandler(upsertRosterCsv),
);
teacherRouter.delete("/courses/:courseId/roster/:rollNumber", asyncHandler(removeRosterEntry));

// Exams
teacherRouter.post("/courses/:courseId/exams", asyncHandler(createExam));
teacherRouter.get("/courses/:courseId/exams", asyncHandler(listExams));
teacherRouter.get("/exams/:examId", asyncHandler(getExam));
teacherRouter.patch("/exams/:examId", asyncHandler(updateExam));

// Questions
teacherRouter.post("/exams/:examId/questions", asyncHandler(addQuestion));
teacherRouter.get("/exams/:examId/questions", asyncHandler(listQuestions));
teacherRouter.delete("/questions/:questionId", asyncHandler(deleteQuestion));
