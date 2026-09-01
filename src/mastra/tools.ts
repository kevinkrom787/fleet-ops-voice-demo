import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { leadMemory, WORKING_MEMORY_TEMPLATE } from './memory.js';
import { calendlyConfigFromEnv, createBookingLink, listAvailableSlots } from '../calendly.js';

export interface SessionHooks {
  threadId: string;
  resourceId: string;
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

  const readMemory = () =>
    leadMemory.getWorkingMemory({ threadId: hooks.threadId, resourceId: hooks.resourceId });
  const writeMemory = (workingMemory: string) =>
    leadMemory.updateWorkingMemory({ threadId: hooks.threadId, resourceId: hooks.resourceId, workingMemory });

  const saveLeadInfo = createTool({
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

  const checkAvailability = createTool({
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

  const scheduleEstimate = createTool({
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

      return {
        booked: true,
        bookingUrl,
        confirmationSummary: `You're penciled in for ${inputData.chosenSlotLabel}. I'm sending over a confirmation link to lock it in.`,
      };
    },
  });

  return { saveLeadInfo, checkAvailability, scheduleEstimate };
}
