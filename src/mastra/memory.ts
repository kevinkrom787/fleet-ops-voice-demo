import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

export const WORKING_MEMORY_TEMPLATE = `# Operator Session
- **Operator name**:
- **Current machine**:
- **Open issues**:
`;

// Shared across every voice session (this is the "harness memory" store the
// voice agent reads/writes into) - scoped per-resourceId, not per-thread.
export const fleetMemory = new Memory({
  storage: new LibSQLStore({ id: 'fleet-voice-demo', url: 'file:./mastra-fleet-demo.db' }),
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      template: WORKING_MEMORY_TEMPLATE,
    },
  },
});
