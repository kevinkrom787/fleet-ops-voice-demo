import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { OpenAIRealtimeVoice } from '@mastra/voice-openai-realtime';
import { createFleetVoiceAgent } from './mastra/agent.js';
import { fleetMemory } from './mastra/memory.js';
import type { JobEvent } from './mastra/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single stable operator identity for this demo so working memory persists
// across page refreshes/reconnects (resource-scoped, per src/mastra/memory.ts).
const DEMO_RESOURCE_ID = 'demo-operator';

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/memory', async (_req, res) => {
  const workingMemory = await fleetMemory.getWorkingMemory({
    threadId: 'unused-for-resource-scope',
    resourceId: DEMO_RESOURCE_ID,
  });
  res.json({ workingMemory });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws: WebSocket, message: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

wss.on('connection', (ws) => {
  const threadId = randomUUID();
  let voice: OpenAIRealtimeVoice | null = null;
  let voiceOpen = false;

  const onJobEvent = (event: JobEvent) => send(ws, { channel: 'job', ...event });

  const agent = createFleetVoiceAgent({
    threadId,
    resourceId: DEMO_RESOURCE_ID,
    onJobEvent,
    speak: async (text) => {
      if (voice) await voice.speak(text);
    },
  });

  let closed = false;

  (async () => {
    try {
      voice = (await agent.getVoice()) as unknown as OpenAIRealtimeVoice;

      voice.on('speaking', ({ audio }: { audio: Buffer | Int16Array }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
        }
      });
      voice.on('writing', ({ text, role, response_id }: { text: string; role: string; response_id: string }) => {
        send(ws, { channel: 'transcript', role, text, response_id });
      });
      voice.on('tool-call-start', (evt: { toolName: string; args: unknown }) => {
        send(ws, { channel: 'tool-start', toolName: evt.toolName, args: evt.args });
      });
      voice.on('tool-call-result', (evt: { toolName: string; args: unknown; result: unknown }) => {
        send(ws, { channel: 'tool-result', toolName: evt.toolName, args: evt.args, result: evt.result });
      });
      voice.on('error', (err: unknown) => {
        console.error('[voice error]', err);
        send(ws, { channel: 'error', message: describeError(err) });
      });

      await voice.connect();
      voiceOpen = true;
      send(ws, { channel: 'status', status: 'connected' });
    } catch (err) {
      const message = describeError(err);
      console.error('[voice connect failed]', err);
      send(ws, { channel: 'error', message: `Failed to connect to OpenAI Realtime: ${message}` });
      ws.close();
    }
  })();

  ws.on('message', (data, isBinary) => {
    if (!voice || !voiceOpen || closed) return;
    if (isBinary) {
      const buf = data as Buffer;
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      void voice.send(new Int16Array(arrayBuffer));
    }
  });

  ws.on('close', () => {
    closed = true;
    voice?.close();
  });
  ws.on('error', () => {
    closed = true;
    voice?.close();
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('\n⚠️  OPENAI_API_KEY is not set - copy .env.example to .env and add your key.\n');
  }
  console.log(`Fleet Ops Voice Agent demo running at http://localhost:${PORT}`);
});
