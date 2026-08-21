import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const workflowInputSchema = z.object({
  machineId: z.string(),
  issueDescription: z.string().optional(),
});

const telemetrySchema = z.object({
  machineId: z.string(),
  issueDescription: z.string().optional(),
  engineHours: z.number(),
  vibrationLevelMm: z.number(),
  oilPressurePsi: z.number(),
  bearingWearPct: z.number(),
});

const diagnosticOutputSchema = z.object({
  machineId: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  recommendation: z.string(),
  metrics: z.object({
    engineHours: z.number(),
    vibrationLevelMm: z.number(),
    oilPressurePsi: z.number(),
    bearingWearPct: z.number(),
  }),
});

// Deterministic pseudo-random telemetry per machine ID, so the same machine
// gives consistent numbers across a demo run instead of pure random noise.
function seededTelemetry(machineId: string) {
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    hash = (hash * 31 + machineId.charCodeAt(i)) >>> 0;
  }
  const rand = (salt: number) => ((hash * (salt + 1) * 2654435761) >>> 0) / 4294967295;
  return {
    engineHours: Math.round(4000 + rand(1) * 8000),
    vibrationLevelMm: Math.round((2 + rand(2) * 8) * 10) / 10,
    oilPressurePsi: Math.round(35 + rand(3) * 25),
    bearingWearPct: Math.round(rand(4) * 100),
  };
}

const pullTelemetryStep = createStep({
  id: 'pull-telemetry',
  inputSchema: workflowInputSchema,
  outputSchema: telemetrySchema,
  execute: async ({ inputData }) => {
    // Stand-in for a real telematics/fleet-API call (e.g. Cat VisionLink, an MCP tool).
    await sleep(1800);
    const telemetry = seededTelemetry(inputData.machineId);
    return { ...inputData, ...telemetry };
  },
});

const analyzeStep = createStep({
  id: 'analyze-and-recommend',
  inputSchema: telemetrySchema,
  outputSchema: diagnosticOutputSchema,
  execute: async ({ inputData }) => {
    await sleep(1600);
    const { machineId, engineHours, vibrationLevelMm, oilPressurePsi, bearingWearPct } = inputData;

    let severity: 'low' | 'medium' | 'high' = 'low';
    if (bearingWearPct > 70 || vibrationLevelMm > 8) severity = 'high';
    else if (bearingWearPct > 40 || vibrationLevelMm > 5) severity = 'medium';

    const recommendation =
      severity === 'high'
        ? 'Schedule a service bay visit within the next 48 hours and pull the unit from active duty until inspected.'
        : severity === 'medium'
          ? 'Schedule a routine maintenance check within the next two weeks.'
          : 'No action needed. Recheck at the next scheduled service interval.';

    const summary = `Machine ${machineId} at ${engineHours} engine hours: bearing wear ${bearingWearPct}%, vibration ${vibrationLevelMm}mm/s, oil pressure ${oilPressurePsi}psi.`;

    return {
      machineId,
      severity,
      summary,
      recommendation,
      metrics: { engineHours, vibrationLevelMm, oilPressurePsi, bearingWearPct },
    };
  },
});

export const diagnosticWorkflow = createWorkflow({
  id: 'equipment-diagnostic-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: diagnosticOutputSchema,
})
  .then(pullTelemetryStep)
  .then(analyzeStep)
  .commit();
