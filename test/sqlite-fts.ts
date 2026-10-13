import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
export const hasFts5 = Boolean(db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get()?.enabled);
db.close();
