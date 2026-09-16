import { DatabaseSync } from 'node:sqlite';

/**
 * Replaces `@mastra/memory` + `@mastra/libsql`. Same idea as tool.ts: this
 * app only ever used Memory's "resource-scoped working memory" - a single
 * markdown blob keyed by resourceId, read/written whole. That's one table
 * and two functions, not a library - see src/workos/db.ts and
 * src/diy-auth/db.ts for the exact same node:sqlite pattern used elsewhere
 * in this repo. Dropping Mastra here removes a second database engine
 * (libSQL) the app didn't actually need alongside sqlite.
 */
export const WORKING_MEMORY_TEMPLATE = `# Roofing Lead
- **Name**:
- **Phone**:
- **Address**:
- **Reason for calling**:
- **Requested appointment**:
- **Booking link**:
`;

const memoryDb = new DatabaseSync('./black-bear-scheduling.db');

memoryDb.exec(`
  CREATE TABLE IF NOT EXISTS working_memory (
    resource_id TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function getWorkingMemory(resourceId: string): string {
  const row = memoryDb.prepare(`SELECT content FROM working_memory WHERE resource_id = ?`).get(resourceId) as
    | { content: string }
    | undefined;
  return row?.content ?? '';
}

export function updateWorkingMemory(resourceId: string, content: string): void {
  memoryDb
    .prepare(
      `INSERT INTO working_memory (resource_id, content) VALUES (?, ?)
       ON CONFLICT(resource_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
    )
    .run(resourceId, content);
}
