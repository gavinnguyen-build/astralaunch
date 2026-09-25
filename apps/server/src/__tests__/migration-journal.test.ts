/**
 * Ensures every .sql file in migrations/ is registered in the Drizzle
 * journal (_journal.json).  A missing entry means `pnpm db:migrate` will
 * silently skip the migration on fresh databases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname!, '../db/migrations');
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

describe('Drizzle migration journal', () => {
  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
  const journalTags = new Set(journal.entries.map(e => e.tag));

  const sqlFiles = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  it('every .sql migration file is listed in _journal.json', () => {
    const missing: string[] = [];
    for (const file of sqlFiles) {
      const tag = file.replace(/\.sql$/, '');
      if (!journalTags.has(tag)) {
        missing.push(file);
      }
    }
    expect(missing, `Missing from _journal.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('every journal entry has a corresponding .sql file', () => {
    const sqlTags = new Set(sqlFiles.map(f => f.replace(/\.sql$/, '')));
    const orphaned: string[] = [];
    for (const tag of journalTags) {
      if (!sqlTags.has(tag)) {
        orphaned.push(tag);
      }
    }
    expect(orphaned, `Journal entries without .sql file: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('journal entry indices are sequential starting from 0', () => {
    for (let i = 0; i < journal.entries.length; i++) {
      expect(journal.entries[i].idx).toBe(i);
    }
  });

  it('journal entry timestamps are non-decreasing', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThanOrEqual(journal.entries[i - 1].when);
    }
  });
});
