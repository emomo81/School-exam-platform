import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, withTransaction } from "../db.js";
import { badRequest } from "../http.js";
import { currentUser, requireExamAccess } from "../middleware/auth.js";

const mcqSchema = z.object({
  type: z.literal("mcq"),
  body: z.string().trim().min(1),
  marks: z.number().int().min(0).default(1),
  options: z
    .array(z.object({ label: z.string().trim().min(1), is_correct: z.boolean().default(false) }))
    .min(2)
    .max(10),
});

const essaySchema = z.object({
  type: z.literal("essay"),
  body: z.string().trim().min(1),
  marks: z.number().int().min(0).default(1),
  model_answer: z.string().trim().optional(),
});

const questionSchema = z.discriminatedUnion("type", [mcqSchema, essaySchema]);

/** POST /teacher/exams/:examId/questions — add an MCQ (with options) or essay question. */
export async function addQuestion(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  const parsed = questionSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest("Invalid question. MCQ needs body + 2–10 options; essay needs body.");
  }
  const q = parsed.data;

  if (q.type === "mcq" && !q.options.some((o) => o.is_correct)) {
    throw badRequest("An MCQ must have at least one correct option.");
  }

  const question = await withTransaction(async (client) => {
    await requireExamAccess(client, user, req.params.examId);

    const nextPos = await client.query(
      `select coalesce(max(position), 0) + 1 as pos from questions where exam_id = $1`,
      [req.params.examId],
    );

    const inserted = await client.query(
      `insert into questions (exam_id, type, body, marks, model_answer, source, review_status, position)
       values ($1, $2, $3, $4, $5, 'manual', 'approved', $6)
       returning id, type, body, marks, model_answer, position`,
      [
        req.params.examId,
        q.type,
        q.body,
        q.marks,
        q.type === "essay" ? q.model_answer ?? null : null,
        nextPos.rows[0].pos,
      ],
    );
    const question = inserted.rows[0];

    if (q.type === "mcq") {
      let pos = 1;
      const options = [];
      for (const opt of q.options) {
        const o = await client.query(
          `insert into question_options (question_id, label, is_correct, position)
           values ($1, $2, $3, $4) returning id, label, is_correct, position`,
          [question.id, opt.label, opt.is_correct, pos++],
        );
        options.push(o.rows[0]);
      }
      question.options = options;
    }

    await recomputeTotalMarks(client, req.params.examId);
    return question;
  });

  res.status(201).json({ question });
}

/** GET /teacher/exams/:examId/questions — questions with their options. */
export async function listQuestions(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction((client) => requireExamAccess(client, user, req.params.examId));

  const questions = await pool.query(
    `select id, type, body, marks, model_answer, source, review_status, position
       from questions where exam_id = $1 order by position`,
    [req.params.examId],
  );
  const options = await pool.query(
    `select o.id, o.question_id, o.label, o.is_correct, o.position
       from question_options o
       join questions q on q.id = o.question_id
      where q.exam_id = $1 order by o.position`,
    [req.params.examId],
  );
  const byQuestion = new Map<string, unknown[]>();
  for (const o of options.rows) {
    if (!byQuestion.has(o.question_id)) byQuestion.set(o.question_id, []);
    byQuestion.get(o.question_id)!.push(o);
  }
  const withOptions = questions.rows.map((q) => ({ ...q, options: byQuestion.get(q.id) ?? [] }));
  res.json({ questions: withOptions });
}

/** DELETE /teacher/questions/:questionId */
export async function deleteQuestion(req: Request, res: Response): Promise<void> {
  const user = currentUser(req);
  await withTransaction(async (client) => {
    const examRes = await client.query(`select exam_id from questions where id = $1`, [req.params.questionId]);
    if (examRes.rowCount === 0) return; // already gone → idempotent
    const examId = examRes.rows[0].exam_id;
    await requireExamAccess(client, user, examId);
    await client.query(`delete from questions where id = $1`, [req.params.questionId]);
    await recomputeTotalMarks(client, examId);
  });
  res.json({ status: "deleted" });
}

/** Keep exams.total_marks in sync with the sum of its questions' marks. */
async function recomputeTotalMarks(client: PoolClient, examId: string): Promise<void> {
  await client.query(
    `update exams set total_marks = coalesce(
       (select sum(marks) from questions where exam_id = $1), 0)
     where id = $1`,
    [examId],
  );
}
