import { z } from 'zod';
import { defineTool } from './tool.js';
import { getWorkingMemory, updateWorkingMemory, WORKING_MEMORY_TEMPLATE } from './memory.js';
import { calendlyConfigFromEnv, createBookingLink, listAvailableSlots } from '../calendly.js';
import { getMostRecentAccount } from '../workos/db.js';

export interface SessionHooks {
  resourceId: string;
  /**
   * Fired after a successful scheduleEstimate call. agent.ts wires this to
   * DeepgramVoiceAgent.updatePrompt() - a mid-session prompt update (see the
   * comment on updatePrompt() in deepgram-voice.ts: it *appends*, not replaces),
   * so the rest of the call gets one extra rule without resending the whole prompt.
   */
  onBooked?: () => void;
}

function setLine(lines: string[], label: string, value?: string) {
  if (!value) return;
  const idx = lines.findIndex((l) => l.trim().startsWith(`- **${label}**`));
  const text = `- **${label}**: ${value}`;
  if (idx >= 0) lines[idx] = text;
  else lines.push(text);
}

function getLine(lines: string[], label: string): string {
  const line = lines.find((l) => l.trim().startsWith(`- **${label}**`));
  if (!line) return '';
  return line.split(`- **${label}**:`)[1]?.trim() ?? '';
}

export function createSessionTools(hooks: SessionHooks) {
  const calendlyConfig = calendlyConfigFromEnv();

  const readMemory = async () => getWorkingMemory(hooks.resourceId);
  const writeMemory = async (workingMemory: string) => updateWorkingMemory(hooks.resourceId, workingMemory);

  const saveLeadInfo = defineTool({
    id: 'saveLeadInfo',
    description:
      'Save or update the caller details. Only call this for a piece of information the caller has ' +
      'CONFIRMED - read phone numbers and addresses back to them and get a yes first. Call it once per ' +
      'confirmed piece; you do not need everything at once.',
    inputSchema: z.object({
      name: z.string().optional().describe('Full name, once confirmed'),
      phone: z.string().optional().describe('Phone number, only after reading it back digit by digit and getting a yes'),
      address: z.string().optional().describe('Service address, only after reading it back and getting a yes'),
      reasonForCalling: z.string().optional().describe('Why they are calling - the roof/siding/window/gutter issue'),
    }),
    outputSchema: z.object({ saved: z.boolean(), workingMemory: z.string() }),
    execute: async (inputData) => {
      const lines = ((await readMemory()) || WORKING_MEMORY_TEMPLATE).split('\n');
      setLine(lines, 'Name', inputData.name);
      setLine(lines, 'Phone', inputData.phone);
      setLine(lines, 'Address', inputData.address);
      setLine(lines, 'Reason for calling', inputData.reasonForCalling);
      const workingMemory = lines.join('\n');
      await writeMemory(workingMemory);
      return { saved: true, workingMemory };
    },
  });

  const checkAvailability = defineTool({
    id: 'checkAvailability',
    description:
      'Look up open appointment slots on the Black Bear Exteriors free-estimate calendar for the next ' +
      'several days. Only offer times this tool actually returns - never invent a time.',
    inputSchema: z.object({
      daysAhead: z.number().optional().describe('How many days ahead to search (max 6, default 6)'),
    }),
    outputSchema: z.object({
      slots: z.array(z.object({ label: z.string(), startTimeIso: z.string() })),
    }),
    execute: async (inputData) => {
      const slots = await listAvailableSlots(calendlyConfig, { days: inputData.daysAhead, limit: 5 });
      return { slots };
    },
  });

  const scheduleEstimate = defineTool({
    id: 'scheduleEstimate',
    description:
      "Finalize the appointment once the caller has picked a time from checkAvailability's results. " +
      'Requires name, phone, address, and reason for calling to already be saved via saveLeadInfo - it ' +
      'will tell you what is missing if not. Generates a booking link and saves the choice to the lead record.',
    inputSchema: z.object({
      chosenSlotLabel: z
        .string()
        .describe('The human-readable slot the caller picked, e.g. "Tuesday, September 8 at 2:00 PM EDT"'),
    }),
    outputSchema: z.object({
      booked: z.boolean(),
      missing: z.array(z.string()).optional(),
      bookingUrl: z.string().optional(),
      confirmationSummary: z.string().optional(),
    }),
    execute: async (inputData) => {
      const lines = ((await readMemory()) || WORKING_MEMORY_TEMPLATE).split('\n');

      const required: Array<[string, string]> = [
        ['Name', 'name'],
        ['Phone', 'phone'],
        ['Address', 'address'],
        ['Reason for calling', 'reason for calling'],
      ];
      const missing = required.filter(([label]) => !getLine(lines, label)).map(([, human]) => human);
      if (missing.length > 0) {
        return { booked: false, missing };
      }

      const bookingUrl = await createBookingLink(calendlyConfig);
      setLine(lines, 'Requested appointment', inputData.chosenSlotLabel);
      setLine(lines, 'Booking link', bookingUrl);
      await writeMemory(lines.join('\n'));

      hooks.onBooked?.();

      return {
        booked: true,
        bookingUrl,
        confirmationSummary: `You're penciled in for ${inputData.chosenSlotLabel}. I'm sending over a confirmation link to lock it in.`,
      };
    },
  });

  // --- Track C x Track A: a voice tool that reads Track A's WorkOS-backed DB. ---
  // This demo has no real per-call caller auth (nobody logs into a phone call),
  // so it reads whoever most recently signed in via /login - a stand-in for
  // "resolve the caller's identity" (in production: phone-number lookup, a
  // PIN, or this call happening inside an already-authenticated app session).
  // The point being demoed is mechanical: a Deepgram function-call round trip
  // reading a real row that only exists because Track A's OAuth flow ran.
  const whatOrgAmIIn = defineTool({
    id: 'whatOrgAmIIn',
    description:
      "Look up which organization the currently-signed-in WorkOS account belongs to. Use this if the " +
      'caller asks something like "what account/org is this call under" or "who am I signed in as."',
    inputSchema: z.object({}),
    outputSchema: z.object({
      found: z.boolean(),
      email: z.string().optional(),
      organizationId: z.string().optional(),
    }),
    execute: async () => {
      const account = getMostRecentAccount();
      if (!account) return { found: false };
      return { found: true, email: account.email, organizationId: account.workos_organization_id ?? undefined };
    },
  });

  // --- A second, unrelated tool: demonstrates multiple tools coexisting in one
  // agent.think.functions array, each independently dispatched by name. ---
  const flagForHumanFollowUp = defineTool({
    id: 'flagForHumanFollowUp',
    description:
      'Flag this call for a human teammate to follow up on - use when the caller asks for something ' +
      "outside booking (e.g. an urgent safety issue, a complaint) that shouldn't just be brushed off.",
    inputSchema: z.object({
      reason: z.string().describe('One sentence on why a human should follow up'),
    }),
    outputSchema: z.object({ flagged: z.boolean(), flagId: z.string() }),
    execute: async (inputData) => {
      const flagId = `flag_${Date.now()}`;
      // Demo stub - a real implementation would write to a queue/CRM. Logged
      // here so you can see the tool round trip happen in the server console.
      console.log(`[flagForHumanFollowUp] ${flagId}: ${inputData.reason}`);
      return { flagged: true, flagId };
    },
  });

  return { saveLeadInfo, checkAvailability, scheduleEstimate, whatOrgAmIIn, flagForHumanFollowUp };
}
