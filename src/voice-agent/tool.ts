import type { z } from 'zod';

/**
 * Replaces Mastra's `createTool`. Worth noticing what got lost by dropping it:
 * nothing. `createTool` was a typed identity function - it returned the exact
 * object you passed it, purely so TypeScript could infer `execute`'s input
 * type from `inputSchema`. This app never ran tools through a Mastra `Agent`
 * or tool-execution runtime (deepgram-voice.ts calls `tool.execute()` directly
 * off Deepgram's `FunctionCallRequest`), so there was no framework behavior
 * to replace - just a generic function signature, reproduced below.
 *
 * That's the actual point being demonstrated: Deepgram's Voice Agent API is
 * its own orchestrator (listen -> think -> speak, with FunctionCallRequest/
 * Response as the tool-calling contract). It doesn't need an agent framework
 * sitting on top of it to define or dispatch tools.
 */
// `any` defaults (not `unknown`) are deliberate: DeepgramVoiceAgentConfig.tools is a
// heterogeneous Record<string, VoiceTool> of tools with different input/output types,
// dispatched dynamically by name at runtime (deepgram-voice.ts's handleFunctionCalls) -
// `unknown` here would make that collection type uncheckable via parameter contravariance.
export interface VoiceTool<TInput = any, TOutput = any> {
  id: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
}

export function defineTool<TInput, TOutput>(tool: VoiceTool<TInput, TOutput>): VoiceTool<TInput, TOutput> {
  return tool;
}
