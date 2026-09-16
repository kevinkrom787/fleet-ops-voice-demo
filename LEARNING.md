# LEARNING.md

Built while implementing all three tracks in this repo. Each section: what it does, then value to
three buyers - the **IC** (developer who'd build/maintain this), the **manager** (who owns the
team's velocity and risk), the **exec** (who owns cost and time-to-market) - then what it replaces
in Track B (auth) or a from-scratch pipeline (voice).

---

## Track A vs Track B: WorkOS AuthKit vs. hand-rolled auth

### 1. Hosted login (`GET /login` → AuthKit's page)

**What it does.** `workos.userManagement.getAuthorizationUrl({ provider: 'authkit', clientId,
redirectUri })` returns a URL to a login page WorkOS designs, hosts, and operates - password,
Google, Microsoft, SSO, MFA, whatever the org has configured - and redirects the browser there.
Your server never renders a login form or sees a password.

- **IC value:** no login form to build, style, validate, or secure; no "forgot password" flow, no
  email-sending infra for verification/reset emails, no CAPTCHA/bot-fighting on the login page.
  That's all `src/diy-auth/routes.ts` + a form you don't have to write.
- **Manager value:** one fewer surface the team owns and gets paged for. AuthKit's login page is
  WorkOS's product, tested against every browser/auth-method combination at their scale, not
  yours. Velocity: a new engineer wires up 5 routes instead of a whole auth subsystem.
- **Exec value:** faster time-to-market for anything gated behind login, and the login page itself
  becomes WorkOS's compliance surface (SOC 2, etc.) rather than something your own auditors have
  to review line by line.
- **vs. status quo:** Track B has no equivalent - there is no file to point at, because "build a
  login page" was never a line item. If it existed, it'd be a `/diy/login` HTML form plus all the
  UX debt of password reset, rate limiting, and bot mitigation that this repo doesn't even attempt.

### 2. Callback + sealed session (`GET /callback`)

**What it does.** `authenticateWithCode({ code, session: { sealSession: true, cookiePassword } })`
exchanges the one-time code for a `User` plus tokens, and returns `sealedSession` - an encrypted
blob containing the access token, refresh token, and user, sealed with your `WORKOS_COOKIE_PASSWORD`
so only your server can open it. That blob goes straight into an httpOnly cookie.

- **IC value:** compare `src/workos/routes.ts`'s `/callback` (roughly 15 lines) against
  `src/diy-auth/routes.ts`'s `/diy/login` + `src/diy-auth/session.ts` + `src/diy-auth/password.ts`
  combined (~80 lines) doing the equivalent job - hash comparison, token generation, hashing the
  token before storage, setting the cookie by hand.
- **Manager value:** the failure modes that used to be your team's 2am pages - "someone's `bcrypt`
  cost factor is misconfigured," "the session table has no expiry index and login is slow," "a
  timing attack in the password comparison" - move to WorkOS's on-call, not yours.
- **Exec value:** you're buying down a specific, well-known risk category (credential handling)
  that shows up in nearly every security questionnaire and pen test a B2B customer will run
  against you. Fewer findings, faster procurement cycles.
- **vs. status quo:** `src/diy-auth/password.ts` (bcrypt hash/verify, cost factor tuning, why not
  `===`) and `src/diy-auth/session.ts` (random token generation, SHA-256 the token before storing
  it, expiry checking) are the exact code this callback replaces.

### 3. JWT claims (`sub`, `sid`, `org_id`, `role`, `permissions`, `exp`, ...)

**What it does.** Every WorkOS access token is a JWT carrying `sub` (user id), `sid` (session id -
what `revokeSession()` takes), `org_id`, `role` + `permissions` (scoped to that org membership),
plus `roles` (all orgs), `entitlements`, and `feature_flags`. `session.authenticate()` verifies the
signature against WorkOS's JWKS (cached ~5 min) and hands you the parsed claims - no DB hit.

- **IC value:** authorization checks (`if (role === 'admin')`) read straight off the verified
  token on every request - no join to a memberships table just to find out what someone can do.
- **Manager value:** this is the thing that makes multi-tenant auth *not* your team's problem.
  Track B's `memberships` table is exactly what you'd otherwise build and keep correct as users
  join/leave orgs and roles change.
- **Exec value:** org-scoped roles/permissions are a B2B SaaS requirement customers will ask about
  in the first sales call. Having it "for free" in the token is a checkbox you don't build a
  roadmap item for.
- **vs. status quo:** run `npm run dump:workos` and compare directly - it prints the 3-column
  `accounts` row Track A persists next to the full decoded JWT, then Track B's `memberships` table
  (`src/diy-auth/db.ts`) which is the schema you'd need to reconstruct the same information
  yourself, kept in sync by hand on every membership change.

### 4. Org switching (`POST /switch-org` → `session.refresh({ organizationId })`)

**What it does.** Re-authenticates the *existing* session against a different org the user belongs
to via a refresh-token grant carrying `organization_id` - no redirect to AuthKit, no re-entering
credentials. WorkOS checks membership server-side and issues a new token with the new `org_id`,
`role`, and `permissions`.

- **IC value:** one `session.refresh()` call. No "is this user actually a member of the org they're
  asking to switch to" check to write - WorkOS refuses the request if not.
- **Manager value:** org switchers are a common multi-tenant UI pattern (Slack, Linear, Vercel all
  have one) that's fiddly to get right - stale UI state, race conditions between switching and
  in-flight requests. Getting the *token* side for free removes one whole axis of bugs.
- **Exec value:** this is table stakes for any product sold to companies with multiple
  business units/agencies/franchises under one login - not having it blocks certain deals outright.
- **vs. status quo:** Track B has no `/diy/switch-org` at all. Building it means: an endpoint that
  checks the `memberships` table for `(user_id, target_org_id)`, issues a *new* session token
  scoped to that org, and invalidates or updates the old one - all logic this repo doesn't write
  because Track A doesn't need it written.

### 5. The SSO/directory-sync gap (see the TODO in `src/diy-auth/db.ts`)

**What it does (in Track A).** Nothing extra - `provider: 'authkit'` on the *same*
`getAuthorizationUrl()` call from step 1 already routes an enterprise user to their company's Okta/
Azure AD/Google Workspace connection, and directory sync (SCIM) can keep org membership current
automatically. None of that is separate code in this repo.

- **IC value:** never writing a SAML Service Provider (metadata XML, ACS endpoint, signed
  AuthnRequest/Response parsing) or a per-IdP OIDC client, and never debugging why Okta's
  assertions look slightly different from Azure AD's - this is the single biggest reason engineers
  burn out building auth in-house. The TODO in `src/diy-auth/db.ts` is a receipt for the work
  avoided, not an implementation.
- **Manager value:** SSO-per-customer is usually the point a team's homegrown auth stops scaling -
  every enterprise deal starts asking for it, and each new IdP is bespoke integration work with an
  indefinite maintenance tail. Buying this caps that tail at "call WorkOS's API."
- **Exec value:** SSO is frequently a hard requirement to close enterprise deals ("no SSO" is a
  deal-blocker on many security questionnaires) - and building it yourself is 3-6+ months of
  engineering time you can instead spend on the product itself.
- **vs. status quo:** literally the TODO comment in `src/diy-auth/db.ts` - five numbered items
  (SAML/OIDC per customer, per-customer connection routing, JIT provisioning, SCIM sync, ongoing
  per-IdP maintenance) that exist in this repo only as a comment, because Track A doesn't need any
  of them written.

---

## Track C: Deepgram Voice Agent

### 6. STT - Nova-3 vs. Flux (`agent.listen.provider`)

**What it does.** `listen.provider` picks the speech-to-text model. Nova-3 is silence-based
(VAD): it decides you're done talking after a fixed quiet gap. Flux (`flux-general-en`, `version:
'v2'`) has model-integrated semantic end-of-turn - it decides from *what you said*, tuned by
`eot_threshold` (0.5-1.0, lower = snappier/more false triggers), `eager_eot_threshold` (lets the
LLM start a beat early), and `eot_timeout_ms` (hard cap on trailing silence). See
`buildListenProvider()` in `src/voice-agent/deepgram-voice.ts`.

- **IC value:** turn-taking tuning is 3 numbers in Settings, not a custom VAD/endpointing model
  you train and maintain.
- **Manager value:** "the agent talks over people" / "the agent feels laggy" are the #1 UX
  complaints about voice agents - Flux directly addresses both without a research project.
- **Exec value:** turn-taking quality is the difference between a voice agent that feels usable
  and one that gets abandoned after one bad call - a real product-adoption lever, not a nicety.
- **vs. status quo:** building this yourself means running your own STT (Whisper, etc.), your own
  VAD model, and hand-tuning silence thresholds per use case - a research problem, not an API call.

**Demo mechanic:** the `<select>` in `public/index.html` lets you pick Flux vs. Nova-3 *per call*,
same LLM/tools/scoring held constant - it's passed as `?listen=` on the WS URL (`server.ts`) straight
into `createSchedulingVoiceAgent`'s `listenModel` override. Do one call each way and `/scorecards.html`
shows both rows side by side with a "Variant" column - an apples-to-apples before/after instead of a
claim. Deliberately NOT also stripping tools/barge-in/scoring for the "baseline" - a comparison that
also disables real product features stops being about turn-taking and starts looking rigged.

### 7. TTS (`agent.speak.provider`, Aura-2)

**What it does.** `speak.provider` picks the voice (`aura-2-vesta-en` here - "natural, expressive").
Deepgram streams synthesized audio back over the same WebSocket as binary frames, matched to the
`audio.output` sample rate/encoding declared in Settings.

- **IC value:** one field to swap voices; no separate TTS vendor integration, no audio format
  wrangling between two different providers' conventions.
- **Manager value:** one fewer vendor contract/SLA to manage, one fewer place a call can fail.
- **Exec value:** bundled billing (one Deepgram invoice covers STT+LLM+TTS) simplifies vendor
  management and cost forecasting versus stitching together 3 separate vendor relationships.
- **vs. status quo:** without this you'd integrate ElevenLabs/Cartesia/Play.ht separately, handle
  their own streaming protocol, and glue its audio output timing to your STT/LLM timing by hand.
  (Comment in `agent.ts` notes ElevenLabs/Cartesia sound more lifelike if you bring your own key -
  the swap point is literally one config field, see feature 9.)

### 8. The "think" step (managed LLM, `agent.think.provider`)

**What it does.** `think.provider = { type: 'anthropic', model: 'claude-haiku-4-5' }` with no
`endpoint`/credentials uses a Deepgram-*managed* LLM - Deepgram hosts and bills the model call
against your Deepgram account, so no separate Anthropic/OpenAI API key is needed in this app at all
(see the comment in `src/voice-agent/deepgram-voice.ts`).

- **IC value:** no separate LLM provider account, key, or billing integration to wire up for a
  voice MVP - one Deepgram key covers the whole pipeline.
- **Manager value:** fewer secrets to rotate/manage, fewer places a leaked credential can hurt you.
- **Exec value:** faster to a working demo/pilot - one vendor relationship instead of two before
  you've proven the use case is worth the extra integration.
- **vs. status quo:** running your own orchestration means a separate LLM API integration, your own
  streaming-response handling synced to STT/TTS timing, and a second bill to reconcile.

### 9. Function/tool calling (`agent.think.functions`, `FunctionCallRequest`/`Response`)

**What it does.** Tools declared in Settings (`{ name, description, parameters, client_side }`,
derived from Mastra's `createTool` schemas via `z.toJSONSchema` in `buildSettings()`). Mid-call,
Deepgram sends `FunctionCallRequest` with `{ id, name, arguments, client_side }`; this app finds
the matching tool, runs `execute()`, and replies `{ type: 'FunctionCallResponse', id, name, content }`.
This repo added two: `whatOrgAmIIn` (queries Track A's live SQLite DB mid-call - see
`src/voice-agent/tools.ts`) and `flagForHumanFollowUp` (a second, independent tool, showing several
tools coexisting in one array).

- **IC value:** the LLM can trigger real backend work (DB reads, booking a slot, flagging a human)
  using the exact same tool-definition pattern as any other LLM function-calling API - nothing
  voice-specific to learn beyond the message envelope.
  `whatOrgAmIIn` demonstrates the whole point: a phone call reaching into a real authenticated
  system's data, not a toy demo.
- **Manager value:** this is what turns "a chatbot that talks" into "an agent that does things" -
  the actual product differentiator, and the failure mode to test hardest (a bad tool call is worse
  than a bad sentence).
- **Exec value:** function calling is what makes a voice agent replace actual headcount/workflow
  (booking, lookups, escalation) rather than just being a novelty IVR replacement - it's the ROI
  case, not the demo.
- **vs. status quo:** building this without Deepgram's managed think step means you own the entire
  loop yourself: stream partial transcripts to your LLM, parse its tool-call output, execute, feed
  the result back in, and keep this in sync with TTS timing so the agent doesn't go silent
  mid-thought - Deepgram's orchestrator (`SettingsApplied` → `AgentThinking` → `FunctionCallRequest`
  → `FunctionCallResponse` → `AgentStartedSpeaking`) does that sequencing for you.

### 10. Full agent control: barge-in

**What it does.** When the user starts talking over the agent, Deepgram sends
`UserStartedSpeaking` and stops generating further agent audio on its own - no message needs to be
sent back. The client's job is purely to stop *playing* audio it already received: this app emits
a `user-speaking` event to the browser, which calls `flushPlayback()` (stops all queued
`AudioBufferSourceNode`s and resets the playback cursor) - see `public/app.js`. The official SDKs
wrap the same idea in a `clearMediaBuffer()` helper; this hand-rolled client does it explicitly.

- **IC value:** the mechanism is simpler than it sounds once you see it end to end - one server
  event, one client-side buffer flush. No custom interruption-detection model to build.
- **Manager value:** interruptibility is the #1 thing that makes a voice agent feel human instead
  of robotic - "I said stop and it just kept talking" is a top complaint in voice UX research.
- **Exec value:** directly affects call abandonment/completion rates in any phone-replacing use
  case - a real, measurable product metric, not a cosmetic feature.
- **vs. status quo:** without model-integrated turn-taking, you'd need your own real-time VAD
  running client-side or on a separate audio stream just to *detect* the interruption, before even
  getting to the buffer-flush logic this repo already has.

### 11. Mid-session prompt update (`UpdatePrompt`)

**What it does.** `{ type: 'UpdatePrompt', prompt: '...' }` sent over the same WebSocket mid-call.
**Important and easy to get wrong: it appends to the existing system prompt, it does not replace
it** (confirmed directly from Deepgram's docs during this build - see the comment on
`updatePrompt()` in `src/voice-agent/deepgram-voice.ts`). This repo wires it to a real trigger: once
`scheduleEstimate` succeeds, `agent.ts`'s `hooks.onBooked` callback appends one instruction -
"don't offer to book another appointment" - for the rest of that call only.

- **IC value:** phase changes ("booking is done, now just wrap up," a hand-off to a different
  persona) are one small message, not a new WebSocket session with a full new Settings payload.
  The append-only behavior means you compose instructions instead of managing prompt state by hand.
- **Manager value:** this is the tool for "the agent should behave differently once X happens
  mid-call" without the complexity/cost of restarting the whole session (new STT/TTS warm-up,
  losing conversation context).
- **Exec value:** enables state-aware call flows (qualification → booking → wrap-up, or
  escalation → different tone) without a bigger engineering investment - the guardrail-tightening
  pattern ("stop trying to upsell once X is confirmed") is directly monetizable in a sales-call agent.
- **vs. status quo:** hand-rolling this without a managed orchestrator means either resending an
  entire modified prompt (and hoping the LLM doesn't lose earlier context in the process) or
  maintaining your own prompt-state machine outside the model entirely.

**A real bug this surfaced, found by testing an actual call, not reading the docs:** the first
version fired `updatePrompt()` synchronously inside `scheduleEstimate`'s `execute()` - the instant
the tool returned, before its own `FunctionCallResponse` had even been sent back to Deepgram. That
raced the agent's in-flight response to that same tool call: Deepgram was still composing/speaking
the booking confirmation when the prompt changed underneath it, and the reply fragmented into four
separate utterances ("Perfect." / "You're all set..." / "Someone'll be out...") instead of one
clean sentence. Confirmed in the server's `[voice:...]` event log - `PromptUpdated` landed *before*
`FunctionCallResponse` for the same call. Fix: defer the update until Deepgram's `AgentAudioDone`
confirms the current turn actually finished speaking (`agent.once('agent-audio-done', ...)` in
`agent.ts`). The lesson generalizes past this one demo: any side effect a tool call triggers that
also touches the live session (a prompt change, an injected message, a settings update) needs to be
sequenced against the orchestrator's own turn-completion signal, not fired the instant your code
gets control back.

### 12. No agent framework needed (`src/voice-agent/tool.ts`)

**What it does.** This repo originally wrapped tool definitions and lead-record storage in Mastra
(`createTool`, `@mastra/memory`). Removing both required no behavior change - `src/voice-agent/tool.ts`
is a ~15-line replacement for `createTool` (it was always just a typed identity function; nothing here
ever ran tools through a Mastra `Agent`), and `src/voice-agent/memory.ts` is a ~40-line `node:sqlite`
table replacing `@mastra/memory` + a second database engine (libSQL) the app didn't need. What's left,
`DeepgramVoiceAgent` in `deepgram-voice.ts`, *is* the orchestrator - Deepgram's own
listen -> think -> speak loop with `FunctionCallRequest`/`Response` as the tool-calling contract.

- **IC value:** one fewer framework's abstractions to learn, debug, and keep pinned to a compatible
  version - the tool/memory "primitives" you actually use are ~50 lines of code you can read start to
  finish, not an SDK surface.
- **Manager value:** a smaller dependency tree is fewer places a breaking upgrade or a supply-chain
  issue can land. This isn't hypothetical caution - it's the exact refactor that just happened here,
  with zero behavior change and three fewer packages in `package.json`.
- **Exec value:** this is the strongest form of the Deepgram pitch - not "Deepgram integrates with
  your agent framework" but "Deepgram's Voice Agent API doesn't need one." Less vendor surface,
  fewer moving parts between "call comes in" and "task gets done."
- **vs. status quo:** the diff between this repo before and after this change *is* the comparison -
  same features, same tools, same behavior, minus a framework whose only job here was defining a
  typed object shape and storing one markdown string per lead.

### 13. Call scoring (`src/scoring/`)

**What it does.** Every finished call gets graded in the same four buckets a call center uses to
grade a HUMAN agent - deliberately not a bespoke AI-eval taxonomy, so anyone on a business team
recognizes the mental model instantly:

- **Outcome (FCR - First Contact Resolution):** was the job actually done (`taskCompleted`), which
  tools were called (`toolNames`, not just a count - "None called" showing up in red on a booked-
  sounding call is itself a signal, see below), call duration. Deterministic.
- **Economics & Reliability:** latency, estimated cost against Deepgram's published per-minute
  pricing, whether the socket closed cleanly ("fell down" or not). Deterministic.
- **Customer Experience (CSAT + CES):** would the caller hang up happy (CSAT), and how much friction
  did they experience - repeats, corrections (CES, Customer Effort Score). Judgment calls.
- **Compliance:** factually accurate (no ungrounded claims), on-brand (no competitor mentions).
  Judgment calls.

The two judgment-call buckets run as a single LLM-as-judge pass (Claude Haiku 4.5) over the saved
transcript once the call ends, using `client.messages.parse()` + a Zod schema so the grading output
is guaranteed-shape JSON instead of hoped-for prose. Every rationale field is capped to one short
phrase in the prompt (plus a CSS line-clamp safety net in `/scorecards.html`, since an LLM's length
instructions aren't 100% reliable) - a QA dashboard read at a glance breaks the moment one row's
explanation is a paragraph.

The deterministic half also surfaces *live*, mid-call, in a "Live Call Metrics" panel next to the
transcript (`public/index.html`/`app.js`) - duration, running cost, tool-call count, and rolling
latency all tick in real time off the same WebSocket events already powering the transcript and tool
log. CSAT/CES/Compliance deliberately do NOT show live - they need the full transcript to mean
anything, so the panel marks them "scored when call ends" rather than faking a partial number.

**Two real gaps this surfaced, found by testing real calls, not hypotheticals:**

1. **The latency number was always ~0.** A single `LatencyReport` event carries several *different*
   timing metrics as separate messages (`stt_latency`, `ttt_token_latency`, `ttt_text_latency`,
   `ttt_tool_latency`, `tts_latency`, `total_latency`), all in **seconds**, most well under 1. The
   original code averaged all of them together and rounded to an integer millisecond, collapsing
   everything to 0. Fix: track only `total_latency` (the full listen->think->speak round trip - the
   one number that actually maps to "does this feel laggy") and convert seconds to ms correctly.
2. **The judge missed a fully fabricated booking.** On one live Flux call, the LLM never called a
   single tool - it role-played the entire booking flow instead, inventing plausible time slots and
   telling the caller "You're all set - Saturday at 9 AM" with nothing behind it. The deterministic
   layer caught it correctly (`taskCompleted: false`, empty `toolNames`). The judge did not - graded
   from the transcript alone, it saw a coherent, in-character confirmation and returned a perfect
   score with no accuracy flag. **An LLM-as-judge that only reads the transcript can't tell "the
   agent said it booked something" apart from "the agent actually booked something."** Fix: the
   judge now also receives the tool-call ledger (`toolName(args) -> result` for every call that
   session) as ground truth alongside the transcript, with the rubric explicitly instructed to
   cross-check any claimed outcome against it (`src/scoring/judge.ts`, `recorder.ts`'s
   `toolCallLog`). Re-run against the same fabricated transcript, the fixed judge correctly flagged
   it as inaccurate, citing the exact mismatch.

The general lesson on #2: an LLM-as-judge is only as grounded as the context you hand it -
transcript-only judging catches tone and coherence, not whether the agent's claims match what the
system actually did. That's a legitimate, non-obvious point to raise if an interviewer asks "how
would you evaluate a voice agent's reliability."

- **IC value:** a working example of the "cheap deterministic signals vs. LLM-as-judge" split that
  shows up in every real eval/observability system - and a template for grading *any* agent's
  transcripts, not just this one.
- **Manager value:** this is the dashboard that turns "the demo worked when I tried it" into
  "here's the failure rate across N calls" - the actual artifact you'd bring to a go/no-go decision
  on shipping a voice agent, instead of vibes from one test call.
- **Exec value:** this is the concrete answer to "how do we know if this is safe to put in front of
  customers" - hallucination and competitor-mention detection are exactly the categories a brand/
  legal/compliance review will ask about before a voice agent goes live, made measurable instead of
  anecdotal.
- **vs. status quo:** without Deepgram's single-socket orchestration, this scoring layer would need
  to reconcile timing/events across three separate vendor integrations (STT, LLM, TTS) instead of
  one `DeepgramVoiceAgent` emitting a clean event stream (`writing`, `tool-call-result`, `latency`,
  `closed`) to hook a recorder into.

### Where you'd swap in your own LLM/TTS, and why

Both are single config-field swaps in `src/voice-agent/deepgram-voice.ts`'s `buildSettings()`:

- **LLM:** `thinkProvider: { type: 'google' | 'groq' | 'aws_bedrock', model, endpoint, credentials }`
  swaps to a third-party/BYO-key provider. Reasons you would: need a specific model Deepgram
  doesn't host, want prompt-caching economics only your own API key gets you, need to keep LLM
  traffic inside your own cloud VPC for compliance, or want a fine-tuned model.
- **TTS:** the `speak.provider` field could point at a different vendor if Deepgram adds
  passthrough support, or (more commonly today) you'd stop using Deepgram's speak stage entirely
  and pipe `ConversationText` (assistant turns) to ElevenLabs/Cartesia yourself, handling the audio
  merge/timing by hand. Reasons: those vendors are often rated more "lifelike" than Aura-2, or you
  need a specific cloned/branded voice Deepgram doesn't offer.

The tradeoff in both cases: you gain flexibility and lose the "one WebSocket, one vendor, already
synchronized" simplicity that's the actual selling point of the Voice Agent API.

---

## Build vs. buy: WorkOS

| | Build (Track B) | Buy (Track A - WorkOS) |
|---|---|---|
| **Upfront eng cost** | Login form, password hashing, session table, org/membership schema - days, not hours | ~5 routes, 1 SQLite mapping table - hours |
| **SSO / enterprise auth** | 3-6+ months per-IdP integration work, ongoing maintenance | Same `getAuthorizationUrl()` call, `provider: 'authkit'` routes it |
| **Directory sync (SCIM)** | Not built here - would be another substantial subsystem | Included, no separate code |
| **Security surface** | You own password storage, session fixation, timing attacks, rate limiting | WorkOS's compliance surface, not yours |
| **Ongoing cost** | Engineering time (a real person's salary fraction, indefinitely) | Per-MAU pricing (WorkOS has a free tier up to a monthly-active-user threshold) |
| **Failure mode when it breaks** | Your on-call, your incident | WorkOS's on-call, their status page |
| **Where it fits** | You truly need zero external dependencies (air-gapped, extreme cost sensitivity) or auth is your actual product | Auth is necessary but not your differentiator - true for the overwhelming majority of B2B SaaS |

## Build vs. buy: Deepgram Voice Agent

| | Build (STT + LLM + TTS stitched yourself) | Buy (Deepgram Voice Agent API) |
|---|---|---|
| **Integration surface** | 3 separate vendor APIs/SDKs, 3 separate streaming protocols to reconcile | 1 WebSocket, 1 Settings payload |
| **Turn-taking/interruption** | Your own VAD/endpointing model, or a fixed-silence heuristic | Flux semantic EOT + `UserStartedSpeaking` built in |
| **Tool calling** | Your own loop: stream transcript → LLM → parse tool call → execute → re-inject | `FunctionCallRequest`/`Response` envelope, sequenced by the orchestrator |
| **Latency** | You own the pipeline's end-to-end latency budget across 3 vendors | One vendor optimizing the whole chain together |
| **Billing/vendor mgmt** | 3 invoices, 3 SLAs, 3 outage surfaces | 1 invoice (unless you BYO an LLM/TTS key) |
| **Flexibility** | Full control - any model, any voice, any provider | Config-field swaps for LLM (`thinkProvider`) and DIY for TTS if you want a different vendor |
| **Where it fits** | You need a specific model/voice Deepgram doesn't offer, or compliance requires your own infra | You want a working voice agent in days, and "good enough, integrated" beats "best-in-class, stitched together" for your timeline |
