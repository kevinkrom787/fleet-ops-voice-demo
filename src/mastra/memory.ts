import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';

export const WORKING_MEMORY_TEMPLATE = `# Roofing Lead
- **Name**:
- **Phone**:
- **Address**:
- **Reason for calling**:
- **Requested appointment**:
- **Booking link**:
`;

// Shared across every voice session (this is the "harness memory" store the
// voice agent reads/writes into) - scoped per-resourceId, not per-thread.
export const leadMemory = new Memory({
  storage: new LibSQLStore({ id: 'black-bear-scheduling', url: 'file:./black-bear-scheduling.db' }),
  options: {
    lastMessages: 20,
    workingMemory: {
      enabled: true,
      scope: 'resource',
      template: WORKING_MEMORY_TEMPLATE,
    },
  },
});
