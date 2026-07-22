import type { Request, Response } from "express";
import { z } from "zod";
import { withTransaction } from "../db.js";
import { badRequest, HttpError, notFound } from "../http.js";
import { currentAttempt } from "../middleware/student.js";
import { autoSubmitIfExpired, orderedQuestionIds } from "./service.js";

const bodySchema = z.object({ answer: z.string().max(20000) });

/**
 * PUT /exam/answers/:questionId — save (or overwrite) the answer to one question.
 * Enforces: attempt in_progress, server-side end_at cutoff (per-write, PRD §4.1),
 * question belongs to the exam, valid option for MCQs, and backtracking policy.
 */
export async function saveAnswer(req: Request, res: Response): Promise<void> {
  const { sub: attemptId, roll_number, exam_id } = currentAttempt(req);
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) throw badRequest("Body must be { answer: string }.");
  const { answer } = parsed.data;
  const questionId = req.params.questionId;

  await withTransaction(async (client) => {
    const meta = await client.query(
      `select a.status, e.end_at, e.backtracking_allowed
         from attempts a join exams e on e.id = a.exam_id
        where a.id = $1`,
      [attemptId],
    );
    if (meta.rowCount === 0) throw notFound("Attempt not found.");
    const { status, end_at, backtracking_allowed } = meta.rows[0];

    // Authoritative cutoff: if time is up, close the attempt and reject the write.
    const effectiveStatus = await autoSubmitIfExpired(client, {
      attemptId,
      rollNumber: roll_number,
      examId: exam_id,
      endAt: new Date(end_at),
      status,
    });
    if (effectiveStatus === "auto_submitted_timer") {
      throw new HttpError(409, "exam_ended", "Time is up; your exam has been submitted.");
    }
    if (effectiveStatus !== "in_progress") {
      throw new HttpError(409, "exam_not_active", "This attempt is no longer active.");
    }

    // The question must belong to this exam.
    const q = await client.query(
      `select id, type from questions where id = $1 and exam_id = $2`,
      [questionId, exam_id],
    );
    if (q.rowCount === 0) throw notFound("Question not found for this exam.");
    const question = q.rows[0];

    // Backtracking policy — relative to the student's shuffled navigation order.
    if (!backtracking_allowed) {
      const order = await orderedQuestionIds(client, exam_id, attemptId);
      const targetIdx = order.indexOf(questionId);
      const answered = await client.query(
        `select question_id from attempt_answers where attempt_id = $1`,
        [attemptId],
      );
      const maxAnsweredIdx = answered.rows.reduce(
        (max, r) => Math.max(max, order.indexOf(r.question_id)),
        -1,
      );
      if (maxAnsweredIdx >= 0 && targetIdx < maxAnsweredIdx) {
        throw new HttpError(409, "backtracking_disabled", "Returning to previous questions is disabled for this exam.");
      }
    }

    // Validate the answer shape.
    if (question.type === "mcq") {
      // Compare as text so a non-UUID answer yields 0 rows (400) instead of a
      // Postgres uuid-parse error (500).
      const opt = await client.query(
        `select 1 from question_options where id::text = $1 and question_id = $2`,
        [answer, questionId],
      );
      if (opt.rowCount === 0) throw badRequest("Answer must be a valid option id for this question.");
    }

    // Persist as entered (supports resume — PRD §4.10). Grading happens at Phase 6.
    await client.query(
      `insert into attempt_answers (attempt_id, question_id, answer, updated_at)
       values ($1, $2, to_jsonb($3::text), now())
       on conflict (attempt_id, question_id)
         do update set answer = excluded.answer, updated_at = now()`,
      [attemptId, questionId, answer],
    );
  });

  res.json({ status: "saved" });
}
