import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import type { ToolSet } from '@mastra/core/tools';
type AnyTool = ToolSet[string];

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
  tools: ToolSet;
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
 * a single realtime speech-to-speech socket (STT + LLM + TTS), analogous to the
 * `OpenAIRealtimeVoice` this replaced. Mastra has no wrapper for this API, so this is a
 * hand-rolled `EventEmitter` shaped to match what src/server.ts already expects
 * (`speaking` / `writing` / `tool-call-start` / `tool-call-result` / `error`), plus a
 * `user-speaking` event for client-side barge-in handling.
 *
 * Tool calling: function definitions are derived from the Mastra tools passed in
 * (`tool.id` / `tool.description` / `z.toJSONSchema(tool.inputSchema)`) and declared as
 * client-side functions. When Deepgram sends `FunctionCallRequest`, the matching tool's
 * `execute()` runs here and the result is returned via `FunctionCallResponse`.
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

  private handleMessage(msg: Record<string, unknown>, onSettingsApplied: () => void) {
    switch (msg.type) {
      case 'SettingsApplied':
        this.startKeepAlive();
        onSettingsApplied();
        break;
      case 'ConversationText':
        this.emit('writing', {
          role: msg.role === 'user' ? 'user' : 'assistant',
          text: String(msg.content ?? ''),
          response_id: randomUUID(),
        });
        break;
      case 'UserStartedSpeaking':
        this.emit('user-speaking');
        break;
      case 'FunctionCallRequest': {
        const calls = (msg.functions as Array<Record<string, unknown>>) ?? [];
        void this.handleFunctionCalls(calls);
        break;
      }
      case 'Warning':
        this.emit('error', new Error(`Deepgram warning: ${msg.description ?? JSON.stringify(msg)}`));
        break;
      case 'Error':
        this.emit('error', new Error(`Deepgram error: ${msg.description ?? JSON.stringify(msg)}`));
        break;
      default:
        // Welcome, AgentThinking, AgentStartedSpeaking, AgentAudioDone, etc. - no-ops here.
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
        result = await (tool.execute as (input: Record<string, unknown>, context?: unknown) => Promise<unknown>)(args, {});
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
