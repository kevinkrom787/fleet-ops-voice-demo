# WorkOS + Deepgram

Part interview prep, part real work: I'm doing consulting for construction companies here in Denver, and I wanted to actually understand what a voice agent involves before pitching one — not just read the docs. That happened to line up with interviews at WorkOS and Deepgram, so I went deep on both.

The voice agent is a scheduling assistant — books a free estimate over a live phone call in your browser, the kind of thing a small construction company could use to stop losing leads to a voicemail box. The hard part wasn't getting it to talk, it was getting the conversation to not feel wonky. Deepgram's Flux model does semantic end-of-turn instead of a silence timer, which is the difference between an agent that talks over you and one that doesn't - I built a toggle to A/B it against the older Nova-3 model live, so you can actually hear the difference. I also hit a real bug mid-build: a mid-call prompt update fired while the agent was still composing its booking confirmation, and the reply fragmented into four sentences instead of one. Fixed it by waiting for Deepgram's own turn-completion signal instead of firing the instant my code got control back.

The other half is tool calling and orchestration. Deepgram's own WebSocket already runs the full listen → think → speak loop and the function-calling round trip - which is a bigger deal than it sounds. I ripped out the agent framework (Mastra) I started with, because it wasn't doing anything Deepgram doesn't already handle natively.

Then there's the question every voice-agent build eventually runs into: how do you know if it's actually good, and how do you keep it good over time? I built a scorecard that grades every call on the same axes a call center grades a human rep - CSAT, effort, accuracy, on-brand - with an LLM judging the transcript. Worth mentioning: the first version was wrong in an interesting way. It gave a call a perfect score on a run where the agent had fully fabricated a booking and never called a single tool. Fixed by grounding the judge in the actual tool-call log, not just the transcript.

Deeper write-up in [LEARNING.md](./LEARNING.md), including the WorkOS side - auth built the hard way, sitting right next to AuthKit doing the same thing in a few lines.

## Run it

```
cp .env.example .env && npm install && npm run dev
```

Open `localhost:3000`.

---

Both products are legitimately rad to build with. If there's ever room on either team, I'd love to connect.
