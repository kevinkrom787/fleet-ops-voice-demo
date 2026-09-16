/**
 * Deepgram Voice Agent API pricing, confirmed directly from deepgram.com/pricing
 * on 2026-09-15 (pay-as-you-go rates). The Voice Agent API bills per minute of
 * WebSocket connection time as ONE bundled rate covering STT+LLM+TTS+orchestration
 * - it is not itemized per component, which is itself part of the pitch (see
 * LEARNING.md): one number on your invoice instead of three vendors' worth.
 *
 *   Standard tier: $0.075/min (PAYG) - covers Deepgram-managed lighter-weight LLMs
 *   Advanced tier: $0.163/min (PAYG) - covers premium managed LLMs / more capability
 *
 * Deepgram doesn't publish an exact per-model tier table, so this is an ESTIMATE for
 * demo purposes, not an invoice reconciliation. This app's think.provider defaults to
 * claude-haiku-4-5 (see agent.ts), which is the closer fit for "standard."
 */
export const DEEPGRAM_VOICE_AGENT_RATE_PER_MIN = {
  standard: 0.075,
  advanced: 0.163,
} as const;

export function estimateCallCostUsd(durationMs: number, tier: keyof typeof DEEPGRAM_VOICE_AGENT_RATE_PER_MIN = 'standard'): number {
  const minutes = durationMs / 60_000;
  const cost = minutes * DEEPGRAM_VOICE_AGENT_RATE_PER_MIN[tier];
  return Math.round(cost * 10_000) / 10_000;
}
