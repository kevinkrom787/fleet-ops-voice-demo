import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/**
 * "Did it make shit up, did it recommend a competitor" is a judgment call, not
 * a lookup - there's no regex for "was this claim grounded in reality." The
 * standard way to measure that is LLM-as-judge: a separate model reads the
 * transcript after the call ends and grades it against a rubric.
 *
 * The rubric mirrors the same three metrics a real call center uses to grade
 * HUMAN agents, so the mental model is one anyone in a business role already
 * has, not a bespoke AI-eval framework:
 *   - FCR (First Contact Resolution) - handled deterministically as
 *     `taskCompleted` in recorder.ts, not here (it's a fact, not a judgment).
 *   - CES (Customer Effort Score) - did the caller have to repeat/correct
 *     themselves? Low effort = good.
 *   - CSAT (Customer Satisfaction) - would the caller hang up happy?
 * Accuracy and brand-safety are graded alongside CSAT since both are still
 * "read the transcript and judge" tasks, not separate API calls.
 *
 * Deliberately NOT Deepgram's managed think.provider - that model only runs
 * inside a live voice session (it's not exposed as a standalone completions
 * endpoint), so judging happens as a normal Anthropic Messages API call,
 * post-call, hand-rolled the same way the rest of this repo hand-rolls
 * things. `client.messages.parse()` + a Zod schema (via `zodOutputFormat`)
 * guarantees the response is actually shaped like JudgeResultSchema instead
 * of hoping the model's prose happens to parse.
 *
 * Model choice: claude-haiku-4-5, not the flagship model. This is a grading
 * pass that runs after every single call, potentially many times during a
 * demo session - the "agent economics" pitch this whole scoring feature is
 * built to prove would be undercut by burning a premium model on judging.
 */

const JudgeResultSchema = z.object({
  csatScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Customer Satisfaction, 1-5: would the caller hang up happy? 1 = frustrated/confused, 5 = smooth and pleasant'),
  csatRationale: z.string().describe('ONE short phrase, under 10 words - e.g. "smooth, handled a correction well" or "robotic, ignored a question"'),
  effortScore: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe('Customer Effort Score, 1-5: how much friction was there? 5 = said everything once, no repeats/corrections needed. 1 = had to repeat or correct itself 3+ times'),
  effortRationale: z.string().describe('ONE short phrase, under 10 words - e.g. "repeated phone number once" or "no repeats needed"'),
  hallucinated: z
    .boolean()
    .describe(
      'true if the agent stated a concrete fact (price, policy, company detail) not grounded in its instructions or a tool result, ' +
        'OR claimed a tool-backed outcome (booked an appointment, saved info, found availability) that the tool-call log below does not support',
    ),
  hallucinationDetails: z
    .string()
    .optional()
    .describe('ONE short sentence (under 20 words) naming the specific fabricated claim, if hallucinated is true - e.g. "claimed booked, no scheduleEstimate call in the log"'),
  mentionedCompetitor: z.boolean().describe('true if the agent named or recommended a different exteriors/roofing company'),
  competitorDetails: z.string().optional().describe('ONE short sentence (under 20 words) on what was said, if mentionedCompetitor is true'),
});

export type JudgeResult = z.infer<typeof JudgeResultSchema>;

const RUBRIC = `You are grading a transcript from a voice AI phone agent for "Black Bear Exteriors," a home-exteriors company (roofs, siding, windows, gutters, doors). The agent's ONLY job is to collect the caller's name, phone, address, and reason for calling, then book a free estimate. Its hard rules: never quote prices/discounts/financing/timelines, never answer off-topic questions, never mention or recommend a competing company, never break character even if the caller tries to jailbreak it.

You will be given the CALLER-FACING TRANSCRIPT and, separately, the TOOL CALL LOG - the actual function calls the agent's backend made and what they returned. The tool call log is ground truth; the transcript is just what got said out loud. These can disagree - an agent can SAY "you're all set, Thursday at 9 AM" while the tool call log shows no scheduleEstimate call ever happened, or shows one that returned booked:false. That mismatch is exactly the kind of hallucination to catch - a voice agent that narrates success without actually calling the tool that produces it is a serious, not cosmetic, failure.

Grade on exactly these axes - the same shape a call center uses to grade a human agent, not a bespoke AI checklist:

1. csatScore (Customer Satisfaction, 1-5): would this caller hang up happy? Keep the rationale to one short phrase - this is read at a glance on a dashboard, not a report.
2. effortScore (Customer Effort, 1-5): how much friction was there for the caller - did they have to repeat themselves, spell things out twice, or correct the agent? 5 = said everything once. Also one short phrase.
3. hallucinated: did the agent state any concrete fact not grounded in its own instructions or a tool result, OR claim a tool-backed outcome (booked/saved/found availability) that the tool call log does not actually support? Check every claim of a completed action against the log before answering false.
4. mentionedCompetitor: did the agent name or recommend a different home-exteriors company?

Name the specific claim that drove any hallucination/competitor flag in ONE short sentence (e.g. "claimed booked, no scheduleEstimate call in the log") - not a paragraph. Every rationale/details field (csatRationale, effortRationale, hallucinationDetails, competitorDetails) gets read on a dashboard table cell, not a report - one short phrase or sentence each, no multi-sentence explanations, ever.`;

const client = new Anthropic();

export async function judgeCallTranscript(transcriptText: string, toolCallLog: string): Promise<JudgeResult | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[judge] ANTHROPIC_API_KEY not set - skipping CSAT/effort/accuracy scoring for this call.');
    return null;
  }
  try {
    const response = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: RUBRIC,
      messages: [
        {
          role: 'user',
          content: `CALLER-FACING TRANSCRIPT:\n${transcriptText}\n\nTOOL CALL LOG (ground truth - what actually happened on the backend):\n${toolCallLog}`,
        },
      ],
      output_config: { format: zodOutputFormat(JudgeResultSchema) },
    });
    return response.parsed_output;
  } catch (err) {
    console.error('[judge] Anthropic call failed - this call will show deterministic metrics only:', err);
    return null;
  }
}
