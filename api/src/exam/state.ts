import type { Request, Response } from "express";
import { pool, withTransaction } from "../db.js";
import { notFound } from "../http.js";
import { currentAttempt } from "../middleware/student.js";
import { shuffleBySeed } from "./shuffle.js";
import { autoSubmitIfExpired } from "./service.js";

const ENDED_STATUSES = ["submitted", "auto_submitted_timer", "auto_submitted_violation"];

/**
 * GET /exam/state — the load/resume payload for the exam-taking UI.
 * Remaining time is computed server-side; questions are shuffled per attempt
 * and stripped of anything that reveals the answer (is_correct, model_answer).
 */
export async function getExamState(req: Request, res: Response): Promise<void> {
  const { sub: attemptId, roll_number, exam_id } = currentAttempt(req);

  const { exam, status } = await withTransaction(async (client) => {
    const attemptRes = await client.query(
      `select a.status, e.id as exam_id, e.title, e.subject, e.end_at, e.timezone,
              e.duration_minutes, e.backtracking_allowed, e.total_marks, e.passing_pct
         from attempts a join exams e on e.id = a.exam_id
        where a.id = $1`,
      [attemptId],
    );
    if (attemptRes.rowCount === 0) throw notFound("Attempt not found.");
    const row = attemptRes.rows[0];

    const status = await autoSubmitIfExpired(client, {
      attemptId,
      rollNumber: roll_number,
      examId: exam_id,
      endAt: new Date(row.end_at),
      status: row.status,
    });
    return { exam: row, status };
  });

  const remainingSeconds = Math.max(0, Math.floor((new Date(exam.end_at).getTime() - Date.now()) / 1000));
  const examMeta = {
    id: exam.exam_id,
    title: exam.title,
    subject: exam.subject,
    end_at: exam.end_at,
    timezone: exam.timezone,
    duration_minutes: exam.duration_minutes,
    backtracking_allowed: exam.backtracking_allowed,
    total_marks: exam.total_marks,
    passing_pct: exam.passing_pct,
  };

  // If the attempt is over, don't ship the question set.
  if (ENDED_STATUSES.includes(status)) {
    res.json({ status, ended: true, remaining_seconds: 0, exam: examMeta });
    return;
  }

  // Fetch questions + options, strip answer-revealing fields, shuffle per attempt.
  const questionRows = await pool.query(
    `select id, type, body, marks from questions where exam_id = $1`,
    [exam_id],
  );
  const optionRows = await pool.query(
    `select o.id, o.question_id, o.label
       from question_options o join questions q on q.id = o.question_id
      where q.exam_id = $1`,
    [exam_id],
  );
  const optionsByQuestion = new Map<string, { id: string; label: string }[]>();
  for (const o of optionRows.rows) {
    if (!optionsByQuestion.has(o.question_id)) optionsByQuestion.set(o.question_id, []);
    optionsByQuestion.get(o.question_id)!.push({ id: o.id, label: o.label });
  }

  const shuffledQuestions = shuffleBySeed(attemptId, questionRows.rows).map((q, i) => ({
    id: q.id,
    display_index: i + 1,
    type: q.type,
    body: q.body,
    marks: q.marks,
    // Options shuffled with their own seed so their order also varies per attempt.
    options:
      q.type === "mcq"
        ? shuffleBySeed(`${attemptId}:opt`, optionsByQuestion.get(q.id) ?? [])
        : undefined,
  }));

  const answerRows = await pool.query(
    `select question_id, answer from attempt_answers where attempt_id = $1`,
    [attemptId],
  );
  const answers: Record<string, unknown> = {};
  for (const a of answerRows.rows) answers[a.question_id] = a.answer;

  res.json({
    status,
    ended: false,
    remaining_seconds: remainingSeconds,
    exam: examMeta,
    questions: shuffledQuestions,
    answers,
  });
}
