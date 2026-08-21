import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { fleetMemory, WORKING_MEMORY_TEMPLATE } from './memory.js';
import { diagnosticWorkflow } from './workflows/diagnostic-workflow.js';

export type JobEvent =
  | { type: 'job-started'; jobId: string; machineId: string }
  | { type: 'job-step'; jobId: string; step: string }
  | { type: 'job-completed'; jobId: string; result: unknown }
  | { type: 'job-failed'; jobId: string; error: string };

export interface SessionHooks {
  threadId: string;
  resourceId: string;
  onJobEvent: (event: JobEvent) => void;
  /** Speak proactively into the *live* realtime session - used to report background results. */
  speak: (text: string) => Promise<void>;
}

const MOCK_FLEET: Record<string, { name: string; location: string; fuelPct: number; status: string }> = {
  'EX-4471': { name: 'Excavator EX-4471', location: 'Site B - North Pit', fuelPct: 62, status: 'active' },
  'DZ-2210': { name: 'Dozer DZ-2210', location: 'Site A - Laydown Yard', fuelPct: 88, status: 'idle' },
  'HL-3309': { name: 'Haul Truck HL-3309', location: 'Site B - Haul Road 2', fuelPct: 41, status: 'active' },
};

export function createSessionTools(hooks: SessionHooks) {
  const getMachineStatus = createTool({
    id: 'getMachineStatus',
    description:
      'Look up live status for a piece of equipment by machine ID (fuel level, location, operating status).',
    inputSchema: z.object({ machineId: z.string().describe('Equipment ID, e.g. EX-4471') }),
    outputSchema: z.object({
      machineId: z.string(),
      found: z.boolean(),
      name: z.string().optional(),
      location: z.string().optional(),
      fuelPct: z.number().optional(),
      status: z.string().optional(),
    }),
    execute: async (inputData) => {
      const machine = MOCK_FLEET[inputData.machineId];
      return machine
        ? { machineId: inputData.machineId, found: true, ...machine }
        : { machineId: inputData.machineId, found: false };
    },
  });

  const updateOperatorProfile = createTool({
    id: 'updateOperatorProfile',
    description:
      "Save or update what's known about the operator and the machine currently being discussed. Call this whenever the operator gives their name, names a machine they're reporting on, or raises an issue worth remembering for later in the call.",
    inputSchema: z.object({
      operatorName: z.string().optional(),
      currentMachine: z.string().optional(),
      openIssue: z.string().optional(),
    }),
    outputSchema: z.object({ saved: z.boolean(), workingMemory: z.string() }),
    execute: async (inputData) => {
      const existing = await fleetMemory.getWorkingMemory({
        threadId: hooks.threadId,
        resourceId: hooks.resourceId,
      });

      const lines = (existing || WORKING_MEMORY_TEMPLATE).split('\n');
      const setLine = (label: string, value?: string) => {
        if (!value) return;
        const idx = lines.findIndex((l) => l.trim().startsWith(`- **${label}**`));
        const text = `- **${label}**: ${value}`;
        if (idx >= 0) lines[idx] = text;
        else lines.push(text);
      };
      setLine('Operator name', inputData.operatorName);
      setLine('Current machine', inputData.currentMachine);
      setLine('Open issues', inputData.openIssue);
      const workingMemory = lines.join('\n');

      await fleetMemory.updateWorkingMemory({
        threadId: hooks.threadId,
        resourceId: hooks.resourceId,
        workingMemory,
      });

      return { saved: true, workingMemory };
    },
  });

  const runDiagnosticScan = createTool({
    id: 'runDiagnosticScan',
    description:
      'Kick off a full diagnostic scan on a piece of equipment (pulls telemetry, analyzes wear). Takes several seconds - acknowledge to the operator that the scan is running and keep talking with them, you will be given the results once the scan completes.',
    inputSchema: z.object({
      machineId: z.string(),
      issueDescription: z.string().optional().describe('What the operator reported, if anything'),
    }),
    outputSchema: z.object({ status: z.literal('started'), jobId: z.string() }),
    // The realtime-voice tool-call path awaits `execute()` directly rather than
    // routing through Mastra's background-task manager (that manager only wires
    // into the generate()/stream() agentic loop) - so we return fast and run the
    // workflow ourselves below, reporting back via voice.speak() when it lands.
    background: { enabled: true },
    execute: async (inputData) => {
      const jobId = `job-${Date.now()}`;
      hooks.onJobEvent({ type: 'job-started', jobId, machineId: inputData.machineId });

      void (async () => {
        try {
          const run = await diagnosticWorkflow.createRun();
          run.watch((event) => {
            if (event.type === 'workflow-step-start') {
              hooks.onJobEvent({ type: 'job-step', jobId, step: event.payload.id });
            }
          });
          const result = await run.start({
            inputData: { machineId: inputData.machineId, issueDescription: inputData.issueDescription },
          });

          if (result.status === 'success') {
            hooks.onJobEvent({ type: 'job-completed', jobId, result: result.result });
            const r = result.result;
            await hooks.speak(
              `Diagnostic scan complete for ${r.machineId}. ${r.summary} Severity: ${r.severity}. Recommendation: ${r.recommendation}`,
            );
          } else {
            const error = result.status === 'failed' ? result.error.message : result.status;
            hooks.onJobEvent({ type: 'job-failed', jobId, error });
            await hooks.speak(`The diagnostic scan on ${inputData.machineId} did not complete: ${error}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          hooks.onJobEvent({ type: 'job-failed', jobId, error: message });
          await hooks.speak(`I ran into an error running diagnostics on ${inputData.machineId}: ${message}`);
        }
      })();

      return { status: 'started' as const, jobId };
    },
  });

  return { getMachineStatus, updateOperatorProfile, runDiagnosticScan };
}
