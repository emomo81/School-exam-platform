import type { PoolClient } from "pg";
import { shuffledIdOrder } from "./shuffle.js";

/**
 * If the attempt is still in_progress but the exam end time has passed, close it
 * as a timer auto-submit and free the session slot. Returns the effective status.
 * This is the per-request companion to the pg_cron sweeper (migration 0004).
 */
export async function autoSubmitIfExpired(
  client: PoolClient,
  params: { attemptId: string; rollNumber: string; examId: string; endAt: Date; status: string },
): Promise<string> {
  if (params.status !== "in_progress") return params.status;
  if (new Date() <= params.endAt) return params.status;

  await client.query(
    `update attempts set status = 'auto_submitted_timer', submitted_at = now()
      where id = $1 and status = 'in_progress'`,
    [params.attemptId],
  );
  await client.query(
    `delete from active_sessions where roll_number = $1 and exam_id = $2`,
    [params.rollNumber, params.examId],
  );
  return "auto_submitted_timer";
}

/** The attempt's question ids in their stable shuffled order (for backtracking checks). */
export async function orderedQuestionIds(
  client: PoolClient,
  examId: string,
  attemptId: string,
): Promise<string[]> {
  const rows = await client.query(`select id from questions where exam_id = $1`, [examId]);
  return shuffledIdOrder(
    attemptId,
    rows.rows.map((r) => r.id as string),
  );
}
