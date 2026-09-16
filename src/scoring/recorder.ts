import { judgeCallTranscript } from './judge.js';
import { estimateCallCostUsd } from './cost.js';
import { insertCallScore } from './db.js';

interface TranscriptTurn {
  role: string;
  text: string;
}

interface ToolCallRecord {
  toolName: string;
  args: unknown;
  result: unknown;
}

/**
 * One instance per WebSocket connection (created in server.ts alongside the
 * DeepgramVoiceAgent). Accumulates the deterministic signals live during the
 * call - transcript, tool calls, latency samples, how the socket closed -
 * then on finish() computes task-completion (FCR)/cost/reliability and runs
 * the LLM-as-judge pass for CSAT/effort (CES)/accuracy/brand-safety, and
 * writes one row to call-scores.db. See LEARNING.md #13 for why these split
 * into "cheap and deterministic" vs. "needs judgment."
 */
export class CallRecorder {
  private readonly startedAt = Date.now();
  private readonly listenModel: string;
  private readonly transcript: TranscriptTurn[] = [];
  private readonly toolCalls: ToolCallRecord[] = [];
  private taskCompleted = false;
  private closeCode: number | null = null;
  private closeReason = '';
  private hadError = false;
  private readonly latencySamplesMs: number[] = [];
  private finished = false;

  /** listenModel: which STT variant this session used - Flux vs Nova-3, the A/B demo toggle - tagged onto the scored row so /scorecards.html can compare them side by side. */
  constructor(listenModel: string) {
    this.listenModel = listenModel;
  }

  /** ConversationText streams in small chunks per role - append to the open turn. */
  recordTranscriptChunk(role: string, text: string) {
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role) last.text += text;
    else this.transcript.push({ role, text });
  }

  recordToolCall(toolName: string, args: unknown, result: unknown) {
    this.toolCalls.push({ toolName, args, result });
    if (toolName === 'scheduleEstimate' && result && typeof result === 'object' && (result as { booked?: unknown }).booked === true) {
      this.taskCompleted = true;
    }
  }

  /**
   * A single LatencyReport carries several DIFFERENT timing metrics as separate
   * events (stt_latency, ttt_token_latency, ttt_text_latency, ttt_tool_latency,
   * tts_latency, total_latency) - averaging all of them together was a real bug:
   * most of those sub-metrics are well under 1 second, and Deepgram reports them
   * in SECONDS, so averaging-then-rounding-to-ms collapsed everything to 0.
   * total_latency is the one that maps to "does this call feel laggy" (the
   * complete listen -> think -> speak round trip for one turn) - that's the only
   * one worth showing on a scorecard meant to be read at a glance.
   */
  recordLatency(msg: Record<string, unknown>) {
    const totalLatencySeconds = msg.total_latency;
    if (typeof totalLatencySeconds === 'number') this.latencySamplesMs.push(totalLatencySeconds * 1000);
  }

  recordClosed(code: number, reason: string) {
    this.closeCode = code;
    this.closeReason = reason;
  }

  recordError() {
    this.hadError = true;
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    const durationMs = Date.now() - this.startedAt;
    // A clean close is 1000 (normal) or 1001/1005 (browser tab/tab-close semantics).
    // Anything else, or an 'error' event firing mid-call, counts as falling down.
    const fellDown = this.hadError || (this.closeCode !== null && ![1000, 1001, 1005].includes(this.closeCode));

    const transcriptText = this.transcript.map((t) => `${t.role}: ${t.text}`).join('\n');
    // The tool-call ledger is what lets the judge tell "the agent SAID it booked
    // something" apart from "a scheduleEstimate call actually returned booked:true" -
    // without it, a fully fabricated confirmation (LLM narrates success, never calls
    // the tool) reads as perfectly grounded prose. Found by testing a real call - see
    // LEARNING.md #13.
    const toolCallLog = this.toolCalls.length
      ? this.toolCalls.map((t) => `${t.toolName}(${JSON.stringify(t.args)}) -> ${JSON.stringify(t.result)}`).join('\n')
      : '(no tools were called during this call)';
    const judged = transcriptText.trim() ? await judgeCallTranscript(transcriptText, toolCallLog) : null;

    insertCallScore({
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs,
      closeCode: this.closeCode,
      closeReason: this.closeReason,
      fellDown,
      listenModel: this.listenModel,
      taskCompleted: this.taskCompleted,
      toolNames: this.toolCalls.map((t) => t.toolName),
      avgLatencyMs: this.latencySamplesMs.length
        ? Math.round(this.latencySamplesMs.reduce((a, b) => a + b, 0) / this.latencySamplesMs.length)
        : null,
      estimatedCostUsd: estimateCallCostUsd(durationMs),
      csatScore: judged?.csatScore ?? null,
      csatRationale: judged?.csatRationale ?? null,
      effortScore: judged?.effortScore ?? null,
      effortRationale: judged?.effortRationale ?? null,
      hallucinationFlag: judged?.hallucinated ?? null,
      hallucinationDetails: judged?.hallucinationDetails ?? null,
      competitorMentionFlag: judged?.mentionedCompetitor ?? null,
      competitorDetails: judged?.competitorDetails ?? null,
      transcript: this.transcript,
    });
  }
}
