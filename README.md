# Deepgram Voice Agent

Built this to actually get hands-on with Deepgram's Voice Agent API before talking to the team - not just read about it.

The real lesson was turn-taking. Nova-3's silence-based end-of-turn made the agent constantly talk over people or leave awkward pauses - genuinely laggy. Switching to Flux's semantic end-of-turn model fixed it immediately, enough that I built a live toggle so you can A/B the two yourself.

Then I built evals - a scorecard grading every call on CSAT, effort, and accuracy, checked against what the agent's tools actually did, not just what it said out loud. That's the piece I think matters most for getting execs comfortable putting AI in front of real customers: governance and measurement, not just a good demo.

Technical AEs who can sell, demo, and actually deploy something real feel rare - a recruiter told me that's usually where people fall short. That's exactly the gap I built this to close. There are a lot of great AEs out there, but if a spot ever opens up, I'd love to put my name in the hat.
