import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { VoiceTool } from './tool.js';
type AnyTool = VoiceTool;

const AGENT_WS_URL = 'wss://agent.deepgram.com/v1/agent/converse';

export interface DeepgramThinkProvider {
  type: 'open_ai' | 'anthropic' | 'google' | 'groq' | 'aws_bedrock';
  model: string;
  temperature?: number;
}

export interface DeepgramListenConfig {
  /** Default 'flux-general-en' (Flux v2, model-integrated semantic end-of-turn). */
  model?: string;
  /** 'v2' for Flux, 'v1' for Nova. Inferred from the model name if omitted. */
  version?: 'v1' | 'v2';
  /** Flux only. 0.5-1.0 (default 0.7). Lower = snappier turn-taking, more false triggers. */
  eotThreshold?: number;
  /** Flux only. <= eotThreshold. Lets the LLM start before the user fully stops - cuts latency. */
  eagerEotThreshold?: number;
  /** Flux only. Hard cap (ms) on trailing silence before the turn ends regardless of confidence. */
  eotTimeoutMs?: number;
}

export interface DeepgramVoiceAgentConfig {
  apiKey: string;
  instructions: string;
  greeting?: string;
  tools: Record<string, VoiceTool>;
  inputSampleRate?: number;
  outputSampleRate?: number;
  listen?: DeepgramListenConfig;
  speakModel?: string;
  /**
   * `open_ai`/`anthropic` with no `endpoint` are Deepgram-*managed* LLMs - Deepgram hosts and
   * bills the model itself, so no separate OpenAI/Anthropic API key is needed in this app.
   * Only third-party providers (google, groq, aws_bedrock) require your own credentials.
   */
  thinkProvider?: DeepgramThinkProvider;
}

/**
 * Thin client for Deepgram's Voice Agent API (wss://agent.deepgram.com/v1/agent/converse) -
 * a single realtime speech-to-speech socket (STT + LLM + TTS). No agent framework sits on
 * top of this: this class *is* the orchestration layer for this app - a hand-rolled
 * `EventEmitter` shaped to match what src/server.ts expects (`speaking` / `writing` /
 * `tool-call-start` / `tool-call-result` / `error`), plus `user-speaking` for client-side
 * barge-in and `closed`/`latency` for the call-scoring pipeline (see src/scoring/).
 *
 * Tool calling: function definitions are derived from the VoiceTool objects passed in
 * (`tool.id` / `tool.description` / `z.toJSONSchema(tool.inputSchema)`) and declared as
 * client-side functions. When Deepgram sends `FunctionCallRequest`, the matching tool's
 * `execute()` runs here and the result is returned via `FunctionCallResponse` - Deepgram's
 * orchestrator sequences all of this (SettingsApplied -> AgentThinking ->
 * FunctionCallRequest -> FunctionCallResponse -> AgentStartedSpeaking), which is the whole
 * reason no separate agent framework is needed here.
 */
export class DeepgramVoiceAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly toolsByName: Map<string, AnyTool>;

  constructor(private readonly cfg: DeepgramVoiceAgentConfig) {
    super();
    this.toolsByName = new Map(Object.values(cfg.tools).map((tool) => [tool.id, tool]));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(AGENT_WS_URL, {
        headers: { Authorization: `Token ${this.cfg.apiKey}` },
      });
      this.ws = ws;
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      ws.on('open', () => {
        ws.send(JSON.stringify(this.buildSettings()));
      });

      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          this.emit('speaking', { audio: buf });
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.handleMessage(msg, () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });

      ws.on('error', (err) => {
        this.emit('error', err);
        fail(err);
      });

      ws.on('close', (code, reason) => {
        this.stopKeepAlive();
        // Fed to the scoring pipeline's reliability metric (src/scoring/) - a clean
        // close is code 1000; anything else (or a close before Deepgram ever said
        // SettingsApplied) counts as the session "falling down."
        this.emit('closed', { code, reason: reason.toString() });
        if (!settled) fail(new Error(`connection closed before settings applied (${code} ${reason})`));
      });
    });
  }

  private buildListenProvider(): Record<string, unknown> {
    const l = this.cfg.listen ?? {};
    const model = l.model ?? 'flux-general-en';
    const version = l.version ?? (model.startsWith('flux') ? 'v2' : 'v1');

    const provider: Record<string, unknown> = { type: 'deepgram', model };
    if (version === 'v2') {
      // Flux: model-integrated semantic end-of-turn - it decides you're done by *what* you said,
      // not just by silence. Much snappier and more natural turn-taking than Nova's VAD.
      provider.version = 'v2';
      if (l.eotThreshold != null) provider.eot_threshold = l.eotThreshold;
      if (l.eagerEotThreshold != null) provider.eager_eot_threshold = l.eagerEotThreshold;
      if (l.eotTimeoutMs != null) provider.eot_timeout_ms = l.eotTimeoutMs;
    }
    return provider;
  }

  private buildSettings() {
    const functions = [...this.toolsByName.values()].map((tool) => {
      const schema = z.toJSONSchema(tool.inputSchema as z.ZodTypeAny) as Record<string, unknown>;
      delete schema.$schema;
      return { name: tool.id, description: tool.description, parameters: schema };
    });

    return {
      type: 'Settings',
      audio: {
        input: { encoding: 'linear16', sample_rate: this.cfg.inputSampleRate ?? 24000 },
        output: { encoding: 'linear16', sample_rate: this.cfg.outputSampleRate ?? 24000, container: 'none' },
      },
      agent: {
        language: 'en',
        listen: { provider: this.buildListenProvider() },
        think: {
          provider: this.cfg.thinkProvider ?? { type: 'open_ai', model: 'gpt-4o-mini', temperature: 0.7 },
          prompt: this.cfg.instructions,
          functions,
        },
        speak: { provider: { type: 'deepgram', model: this.cfg.speakModel ?? 'aura-2-thalia-en' } },
        ...(this.cfg.greeting ? { greeting: this.cfg.greeting } : {}),
      },
    };
  }

  /**
   * Every message type the orchestrator can send, logged to the console so you can
   * watch listen -> think -> speak happen turn by turn while the app runs. This is
   * the full server-to-client vocabulary as of the current API:
   * Welcome, SettingsApplied, ListenUpdated, ThinkUpdated, PromptUpdated, SpeakUpdated,
   * ConversationText, UserStartedSpeaking, AgentThinking, AgentStartedSpeaking,
   * AgentAudioDone, FunctionCallRequest, FunctionCallCancelled, LatencyReport,
   * History, Audio (binary, handled separately in connect()), Warning, Error.
   */
  private handleMessage(msg: Record<string, unknown>, onSettingsApplied: () => void) {
    switch (msg.type) {
      case 'SettingsApplied':
        console.log('[voice:SettingsApplied]');
        this.startKeepAlive();
        onSettingsApplied();
        break;
      case 'ConversationText':
        // The transcript, one message at a time - role:'user' is what STT (listen)
        // heard, role:'assistant' is what the LLM (think) decided to say next.
        console.log(`[voice:ConversationText] ${msg.role}: ${msg.content}`);
        this.emit('writing', {
          role: msg.role === 'user' ? 'user' : 'assistant',
          text: String(msg.content ?? ''),
          response_id: randomUUID(),
        });
        break;
      case 'UserStartedSpeaking':
        // Turn-taking signal from listen: the user has started talking, possibly
        // over the agent. We don't send anything back to Deepgram for this - it
        // already stops generating/streaming agent audio on its own. Our job is
        // purely client-side: tell the browser to stop *playing* whatever audio
        // it already received and queued (see 'user-speaking' handling in
        // server.ts -> public/app.js's flushPlayback()). That's the actual
        // "clear media buffer" step for a hand-rolled client; the official SDKs
        // just wrap the same idea in a clearMediaBuffer() helper.
        console.log('[voice:UserStartedSpeaking] (barge-in - client flushes queued audio)');
        this.emit('user-speaking');
        break;
      case 'AgentThinking':
        // The 'think' stage has started reasoning about a response. No content
        // is provided (that's not a "chain of thought" leak) - it's purely a
        // timing signal, useful for e.g. showing a "..." indicator in a UI.
        console.log('[voice:AgentThinking]');
        break;
      case 'AgentStartedSpeaking':
        console.log('[voice:AgentStartedSpeaking] (speak stage began streaming audio)');
        break;
      case 'AgentAudioDone':
        console.log('[voice:AgentAudioDone] (speak stage finished this turn)');
        // Emitted so callers can safely defer a follow-up action (like
        // updatePrompt()) until the CURRENT turn is fully spoken - see the
        // comment on hooks.onBooked in agent.ts for why that ordering matters.
        this.emit('agent-audio-done');
        break;
      case 'PromptUpdated':
        console.log('[voice:PromptUpdated] (server confirmed our UpdatePrompt was applied)');
        break;
      case 'History':
        // Full conversation history the server is tracking (text + function-call
        // records) - useful to log once near the end of a session to sanity-check
        // that what the LLM "remembers" matches the transcript you saw.
        console.log('[voice:History]', JSON.stringify(msg.messages ?? msg, null, 2));
        break;
      case 'LatencyReport':
        console.log('[voice:LatencyReport]', msg);
        this.emit('latency', msg);
        break;
      case 'FunctionCallRequest': {
        const calls = (msg.functions as Array<Record<string, unknown>>) ?? [];
        console.log(`[voice:FunctionCallRequest] ${calls.map((c) => c.name).join(', ')}`);
        void this.handleFunctionCalls(calls);
        break;
      }
      case 'FunctionCallCancelled':
        console.log('[voice:FunctionCallCancelled]', msg);
        break;
      case 'Warning':
        console.warn('[voice:Warning]', msg.description ?? msg);
        this.emit('error', new Error(`Deepgram warning: ${msg.description ?? JSON.stringify(msg)}`));
        break;
      case 'Error':
        console.error('[voice:Error]', msg.description ?? msg);
        this.emit('error', new Error(`Deepgram error: ${msg.description ?? JSON.stringify(msg)}`));
        break;
      default:
        // Welcome and any future/undocumented message types land here.
        console.log(`[voice:${String(msg.type)}]`, msg);
        break;
    }
  }

  private async handleFunctionCalls(calls: Array<Record<string, unknown>>) {
    for (const call of calls) {
      if (call.client_side === false) continue; // server-side function, Deepgram handles it itself
      const name = String(call.name);
      const id = String(call.id);
      let args: Record<string, unknown> = {};
      try {
        args = call.arguments ? JSON.parse(String(call.arguments)) : {};
      } catch {
        // fall through with empty args rather than crashing the session over a malformed call
      }

      this.emit('tool-call-start', { toolName: name, args });
      let result: unknown;
      try {
        const tool = this.toolsByName.get(name);
        if (!tool) throw new Error(`Unknown function: ${name}`);
        result = await (tool.execute as (input: Record<string, unknown>) => Promise<unknown>)(args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      this.emit('tool-call-result', { toolName: name, args, result });
      this.sendJSON({ type: 'FunctionCallResponse', id, name, content: JSON.stringify(result) });
    }
  }

  /** Stream mic audio to Deepgram (linear16 PCM matching the configured input sample rate). */
  send(audio: Int16Array | Buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
    this.ws.send(buf);
  }

  /** Proactively make the agent say something mid-session (used to report background job results). */
  async speak(text: string) {
    this.sendJSON({ type: 'InjectAgentMessage', message: text, behavior: 'interrupt' });
  }

  /**
   * Mid-session prompt update. IMPORTANT: per Deepgram's docs, UpdatePrompt
   * *appends to* the existing system prompt - it does not replace it. So this
   * is for adding a rule/instruction for the rest of the call (a phase change,
   * a hand-off, "the booking is done now, stop trying to rebook"), not for
   * swapping the agent's entire persona. If you need a full persona swap,
   * that's a new session with a fresh Settings message, not UpdatePrompt.
   */
  async updatePrompt(additionalInstructions: string) {
    this.sendJSON({ type: 'UpdatePrompt', prompt: additionalInstructions });
  }

  close() {
    this.stopKeepAlive();
    this.ws?.close();
    this.ws = null;
  }

  private sendJSON(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => this.sendJSON({ type: 'KeepAlive' }), 8000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }
}
