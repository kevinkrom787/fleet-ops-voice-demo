import { DatabaseSync } from 'node:sqlite';

/**
 * One row per finished voice-agent call. Same node:sqlite pattern as
 * src/workos/db.ts and src/diy-auth/db.ts.
 *
 * Column groups mirror the same buckets a call center uses to grade a HUMAN
 * agent - the mental model /scorecards.html is built around:
 *   - outcome:      task_completed, tool_names, duration_ms           (FCR)
 *   - economics:    avg_latency_ms, estimated_cost_usd, fell_down
 *   - customer exp: effort_score/rationale, csat_score/rationale      (CES, CSAT)
 *   - compliance:   hallucination_flag, competitor_mention_flag
 * The customer-experience and compliance fields come from an LLM-as-judge
 * pass (see judge.ts) and are nullable because that pass can fail or be
 * skipped (no ANTHROPIC_API_KEY, or an empty transcript). Everything else is
 * deterministic, read straight off the live WebSocket session.
 */
export const scoringDb = new DatabaseSync('./call-scores.db');

scoringDb.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at              TEXT NOT NULL,
    ended_at                TEXT NOT NULL,
    duration_ms             INTEGER NOT NULL,
    close_code              INTEGER,
    close_reason            TEXT,
    fell_down               INTEGER NOT NULL,
    listen_model            TEXT NOT NULL,
    task_completed          INTEGER NOT NULL,
    tool_names_json         TEXT NOT NULL,
    avg_latency_ms          INTEGER,
    estimated_cost_usd      REAL NOT NULL,
    csat_score              INTEGER,
    csat_rationale          TEXT,
    effort_score            INTEGER,
    effort_rationale        TEXT,
    hallucination_flag      INTEGER,
    hallucination_details   TEXT,
    competitor_mention_flag INTEGER,
    competitor_details      TEXT,
    transcript_json         TEXT NOT NULL
  );
`);

export interface CallScoreInput {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  closeCode: number | null;
  closeReason: string;
  fellDown: boolean;
  listenModel: string;
  taskCompleted: boolean;
  toolNames: string[];
  avgLatencyMs: number | null;
  estimatedCostUsd: number;
  csatScore: number | null;
  csatRationale: string | null;
  effortScore: number | null;
  effortRationale: string | null;
  hallucinationFlag: boolean | null;
  hallucinationDetails: string | null;
  competitorMentionFlag: boolean | null;
  competitorDetails: string | null;
  transcript: unknown;
}

export function insertCallScore(input: CallScoreInput): void {
  scoringDb
    .prepare(
      `INSERT INTO calls (
        started_at, ended_at, duration_ms, close_code, close_reason, fell_down, listen_model,
        task_completed, tool_names_json, avg_latency_ms, estimated_cost_usd,
        csat_score, csat_rationale, effort_score, effort_rationale,
        hallucination_flag, hallucination_details,
        competitor_mention_flag, competitor_details, transcript_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.startedAt,
      input.endedAt,
      input.durationMs,
      input.closeCode,
      input.closeReason,
      input.fellDown ? 1 : 0,
      input.listenModel,
      input.taskCompleted ? 1 : 0,
      JSON.stringify(input.toolNames),
      input.avgLatencyMs,
      input.estimatedCostUsd,
      input.csatScore,
      input.csatRationale,
      input.effortScore,
      input.effortRationale,
      input.hallucinationFlag === null ? null : input.hallucinationFlag ? 1 : 0,
      input.hallucinationDetails,
      input.competitorMentionFlag === null ? null : input.competitorMentionFlag ? 1 : 0,
      input.competitorDetails,
      JSON.stringify(input.transcript),
    );
}

export interface CallScoreRow {
  id: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  closeCode: number | null;
  closeReason: string | null;
  fellDown: boolean;
  listenModel: string;
  taskCompleted: boolean;
  toolNames: string[];
  avgLatencyMs: number | null;
  estimatedCostUsd: number;
  csatScore: number | null;
  csatRationale: string | null;
  effortScore: number | null;
  effortRationale: string | null;
  hallucinationFlag: boolean | null;
  hallucinationDetails: string | null;
  competitorMentionFlag: boolean | null;
  competitorDetails: string | null;
  transcript: unknown;
}

export function listCallScores(limit = 50): CallScoreRow[] {
  const rows = scoringDb.prepare(`SELECT * FROM calls ORDER BY id DESC LIMIT ?`).all(limit) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    id: r.id as number,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string,
    durationMs: r.duration_ms as number,
    closeCode: r.close_code as number | null,
    closeReason: r.close_reason as string | null,
    fellDown: !!r.fell_down,
    listenModel: r.listen_model as string,
    taskCompleted: !!r.task_completed,
    toolNames: JSON.parse(String(r.tool_names_json)),
    avgLatencyMs: r.avg_latency_ms as number | null,
    estimatedCostUsd: r.estimated_cost_usd as number,
    csatScore: r.csat_score as number | null,
    csatRationale: r.csat_rationale as string | null,
    effortScore: r.effort_score as number | null,
    effortRationale: r.effort_rationale as string | null,
    hallucinationFlag: r.hallucination_flag === null ? null : !!r.hallucination_flag,
    hallucinationDetails: r.hallucination_details as string | null,
    competitorMentionFlag: r.competitor_mention_flag === null ? null : !!r.competitor_mention_flag,
    competitorDetails: r.competitor_details as string | null,
    transcript: JSON.parse(String(r.transcript_json)),
  }));
}
