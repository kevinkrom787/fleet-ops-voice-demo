# Deepgram Voice Agent

Built this to actually get hands-on with Deepgram's Voice Agent API before talking to the team, not just read about it.

<img width="1440" height="819" alt="Screenshot 2026-09-16 at 1 47 55 PM" src="https://github.com/user-attachments/assets/9d6a4510-eee3-4816-8c69-f33c7266baed" />

The real lesson was turn-taking. Nova-3's silence-based end-of-turn made the agent constantly talk over people or leave awkward pauses... genuinely laggy. Switching to Flux's semantic end-of-turn model fixed it immediately, enough that I built a live toggle so you can A/B the two yourself.

Then I built evals. A scorecard grading every call on CSAT, effort, and accuracy, checked against what the agent's tools actually did, not just what it said out loud. That's the piece I think matters most for getting execs comfortable putting AI in front of real customers: governance and measurement, not just a good demo.

Technical AEs who can sell, demo, and actually deploy something real feel rare. That's exactly the gap I built this to close. There are a lot of great AEs out there, but if a spot ever opens up, I'd love to put my name in the hat.

Evals:
<img width="1471" height="721" alt="Screenshot 2026-09-16 at 1 49 16 PM" src="https://github.com/user-attachments/assets/ace1d619-4dec-469d-b7ff-4d2a3a4418ea" />

## Try it

\`\`\`
git clone https://github.com/kevinkrom787/fleet-ops-voice-demo.git
cd fleet-ops-voice-demo
cp .env.example .env
npm install
npm run dev
\`\`\`
