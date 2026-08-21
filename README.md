# Fleet Ops Voice Agent — Mastra + OpenAI Realtime demo

A working demo of a Mastra voice agent for the Caterpillar Digital pitch: bidirectional
voice over OpenAI's Realtime API, live tool calling, harness-style memory the agent
reads/writes mid-call, and a background workflow that runs while the conversation
keeps going.

## What it demonstrates

- **`OpenAIRealtimeVoice`** (`@mastra/voice-openai-realtime`) wired directly to a Mastra
  `Agent` — no LiveKit or other transport in between.
- **Tool calling live over voice**: `getMachineStatus` (instant lookup) and
  `updateOperatorProfile` (writes to memory) both fire mid-conversation; watch the
  "Tool Calls" panel.
- **Harness memory**: `updateOperatorProfile` writes into a real Mastra `Memory`
  instance (`@mastra/memory` + `@mastra/libsql`), resource-scoped so it survives a
  page refresh. The "Harness Memory" panel polls it live. See the comment in
  `src/mastra/tools.ts` for why this is wired as an explicit tool rather than relying
  on Mastra's automatic working-memory tool injection — that injection only applies
  to the `generate()`/`stream()` text path, not the realtime voice path.
- **Background workflow while staying conversational**: `runDiagnosticScan` kicks off
  a two-step Mastra `Workflow` (`src/mastra/workflows/diagnostic-workflow.ts`) without
  awaiting it, so the agent can immediately acknowledge and keep talking. When the
  workflow finishes, the server calls `voice.speak(...)` to proactively report the
  result into the live session. Watch the "Background Jobs" panel to see the steps
  progress while you keep talking.

## Setup

```bash
npm install        # already done if you're reading this in-place
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
npm run dev
```

Open **http://localhost:3000** in **Chrome** (uses `AudioWorklet` + a fixed-sample-rate
`AudioContext`; not verified in Safari/Firefox), click **Connect**, grant mic access,
and talk.

## Try this during a demo

1. "Hi, I'm Neo, I'm working on excavator EX-4471 today." → watch `updateOperatorProfile`
   fire and the Harness Memory panel update.
2. "What's the status on EX-4471?" → `getMachineStatus` tool call, spoken answer.
3. "It's making a grinding noise, can you run a diagnostic?" → `runDiagnosticScan` fires,
   the agent acknowledges immediately, and you can keep talking — the Background Jobs
   panel steps through `pull-telemetry` → `analyze-and-recommend` over ~3.5s, and the
   agent interrupts with the spoken result when it's done.
4. Refresh the page and reconnect — the operator name/machine are still in the Harness
   Memory panel (resource-scoped, not tied to the browser session).

## Project layout

```
src/
  server.ts                       Express + WS bridge: browser mic <-> OpenAIRealtimeVoice
  mastra/
    agent.ts                      Agent factory (instructions, model, voice, tools)
    tools.ts                      getMachineStatus, updateOperatorProfile, runDiagnosticScan
    memory.ts                     Shared Memory instance (LibSQL, resource-scoped working memory)
    workflows/diagnostic-workflow.ts   The background scan: pull-telemetry -> analyze
public/
  index.html / styles.css / app.js   UI: transcript, tool log, job log, memory panel
  pcm-worklet.js                     Mic capture -> 24kHz PCM16, downsampled in an AudioWorklet
```

## Known limitations (fast-follow items, not blockers for a demo)

- Mic downsampling uses simple decimation (no anti-aliasing filter) — fine for speech,
  not audiophile-grade.
- Single demo operator identity (`DEMO_RESOURCE_ID` in `server.ts`) — fine for a 1:1
  pitch call, would need real auth/session mapping for multi-user use.
- `MOCK_FLEET` and the diagnostic telemetry in the workflow are hardcoded/simulated —
  swap in a real MCP tool or fleet API for a production build.
