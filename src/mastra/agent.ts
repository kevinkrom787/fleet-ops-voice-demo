import { Agent } from '@mastra/core/agent';
import type { MastraVoice } from '@mastra/core/voice';
import { OpenAIRealtimeVoice } from '@mastra/voice-openai-realtime';
import { createSessionTools, type SessionHooks } from './tools.js';

const INSTRUCTIONS = `You are Fleet Ops, a voice assistant for heavy-equipment operators in the field.

You help operators check on equipment status, remember context across the call, and kick off
diagnostic scans when something seems off. Keep responses short and conversational - this is a
live voice call, not a chat window.

Behavior:
- If the operator gives their name, or tells you which machine they're working on or reporting an
  issue with, call updateOperatorProfile to remember it.
- Use getMachineStatus when asked about a specific machine's fuel, location, or state.
- If the operator describes a mechanical problem, or asks for a full diagnostic, call
  runDiagnosticScan. That tool takes several seconds - acknowledge it immediately ("Got it,
  kicking off a scan now, I'll let you know when it's done") and keep the conversation going.
  Do not just go silent while it runs. You will be prompted again automatically with the result
  once it completes, so don't ask the operator to wait.
`;

export function createFleetVoiceAgent(hooks: SessionHooks) {
  const tools = createSessionTools(hooks);
  return new Agent({
    id: 'fleet-ops-voice-agent',
    name: 'Fleet Ops Voice Agent',
    instructions: INSTRUCTIONS,
    // Unused for the realtime call itself (OpenAI's realtime model handles the actual
    // conversation) - Agent still requires a model for tool-wrapping/tracing plumbing.
    model: 'openai/gpt-4o-mini',
    tools,
    // Cast: @mastra/voice-openai-realtime bundles its own internal copy of the
    // MastraVoice base type, so it's structurally identical but nominally
    // distinct from this @mastra/core's MastraVoice at the type level.
    voice: new OpenAIRealtimeVoice({
      // The package's built-in default (gpt-4o-mini-realtime-preview-2024-12-17) is an
      // older preview snapshot many accounts no longer have access to. gpt-realtime is
      // the current GA model; override with OPENAI_REALTIME_MODEL if needed.
      model: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime',
      speaker: 'alloy',
    }) as unknown as MastraVoice,
  });
}
