import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DeepgramVoiceAgent } from './voice-agent/deepgram-voice.js';
import { createSchedulingVoiceAgent } from './voice-agent/agent.js';
import { getWorkingMemory } from './voice-agent/memory.js';
import { workosAuthRouter } from './workos/routes.js';
import { diyAuthRouter } from './diy-auth/routes.js';
import { CallRecorder } from './scoring/recorder.js';
import { listCallScores } from './scoring/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Single stable lead identity for this demo so working memory persists
// across page refreshes/reconnects (resource-scoped, per src/voice-agent/memory.ts).
const DEMO_RESOURCE_ID = 'demo-lead';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// TRACK A: WorkOS AuthKit - GET /login, GET /callback, GET /whoami, POST /switch-org, POST /logout
app.use(workosAuthRouter);
// TRACK B: hand-rolled email+password auth - POST /diy/signup, /diy/login, /diy/logout, GET /diy/whoami
app.use(diyAuthRouter);

app.get('/api/memory', (_req, res) => {
  res.json({ workingMemory: getWorkingMemory(DEMO_RESOURCE_ID) });
});

// Call-scoring dashboard data (see src/scoring/) - most recent call first.
app.get('/api/calls', (_req, res) => {
  res.json({ calls: listCallScores() });
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

wss.on('connection', (ws, req) => {
  let voiceOpen = false;

  // A/B demo toggle: the browser picks Flux vs Nova-3 before connecting (see
  // the <select> in public/index.html) and passes it as a query param on the
  // WS URL - e.g. ws://localhost:3000/ws?listen=nova-3. Same LLM, same tools,
  // same everything else, so the only variable being demoed is turn-taking.
  const requestedListenModel = new URL(req.url ?? '', 'http://localhost').searchParams.get('listen');
  const listenModel = requestedListenModel || process.env.DEEPGRAM_LISTEN_MODEL || 'flux-general-en';

  const voice: DeepgramVoiceAgent = createSchedulingVoiceAgent({ resourceId: DEMO_RESOURCE_ID }, { listenModel });

  // Call-scoring: one recorder per session, fed every event below, written to
  // call-scores.db (and judged for quality/hallucination/competitor mentions)
  // once the call ends. Tagged with listenModel so /scorecards.html can show
  // the Flux-vs-Nova-3 comparison side by side. See src/scoring/recorder.ts.
  const recorder = new CallRecorder(listenModel);

  let closed = false;

  (async () => {
    try {
      voice.on('speaking', ({ audio }: { audio: Buffer | Int16Array }) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength));
        }
      });
      voice.on('writing', ({ text, role, response_id }: { text: string; role: string; response_id: string }) => {
        send(ws, { channel: 'transcript', role, text, response_id });
        recorder.recordTranscriptChunk(role, text);
      });
      voice.on('user-speaking', () => {
        // Barge-in: tell the client to flush whatever agent audio it has scheduled/queued.
        send(ws, { channel: 'user-speaking' });
      });
      voice.on('tool-call-start', (evt: { toolName: string; args: unknown }) => {
        send(ws, { channel: 'tool-start', toolName: evt.toolName, args: evt.args });
      });
      voice.on('tool-call-result', (evt: { toolName: string; args: unknown; result: unknown }) => {
        send(ws, { channel: 'tool-result', toolName: evt.toolName, args: evt.args, result: evt.result });
        recorder.recordToolCall(evt.toolName, evt.args, evt.result);
      });
      voice.on('latency', (msg: Record<string, unknown>) => {
        recorder.recordLatency(msg);
        send(ws, { channel: 'latency', ...msg });
      });
      voice.on('closed', ({ code, reason }: { code: number; reason: string }) => {
        recorder.recordClosed(code, reason);
      });
      voice.on('error', (err: unknown) => {
        console.error('[voice error]', err);
        send(ws, { channel: 'error', message: describeError(err) });
        recorder.recordError();
      });

      await voice.connect();
      voiceOpen = true;
      send(ws, { channel: 'status', status: 'connected', listenModel });
    } catch (err) {
      const message = describeError(err);
      console.error('[voice connect failed]', err);
      send(ws, { channel: 'error', message: `Failed to connect to Deepgram Voice Agent: ${message}` });
      ws.close();
    }
  })();

  ws.on('message', (data, isBinary) => {
    if (!voiceOpen || closed) return;
    if (isBinary) {
      const buf = data as Buffer;
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      voice.send(new Int16Array(arrayBuffer));
    }
  });

  ws.on('close', () => {
    closed = true;
    voice.close();
    void recorder.finish().catch((err) => console.error('[scoring] failed to record call:', err));
  });
  ws.on('error', () => {
    closed = true;
    voice.close();
    void recorder.finish().catch((err) => console.error('[scoring] failed to record call:', err));
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  if (!process.env.DEEPGRAM_API_KEY) {
    console.warn('\n⚠️  DEEPGRAM_API_KEY is not set - copy .env.example to .env and add your key.\n');
  }
  if (!process.env.CALENDLY_API_TOKEN) {
    console.log('ℹ️  CALENDLY_API_TOKEN is not set - checkAvailability/scheduleEstimate will use canned demo availability.\n');
  }
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID || !process.env.WORKOS_COOKIE_PASSWORD) {
    console.warn('⚠️  WORKOS_API_KEY/WORKOS_CLIENT_ID/WORKOS_COOKIE_PASSWORD not fully set - Track A (/login) will fail until they are.\n');
  }
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`  Track A (WorkOS):   http://localhost:${PORT}/login`);
  console.log(`  Track B (DIY auth): POST http://localhost:${PORT}/diy/signup, /diy/login`);
  console.log(`  Track C (voice):    http://localhost:${PORT}/`);
});
