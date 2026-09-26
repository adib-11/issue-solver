import { Database } from "bun:sqlite";

export function openDb(path: string) {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL,
    repo_full_name TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    issue_url TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repo_id, issue_number)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS scan_cursors (
    repo_id INTEGER PRIMARY KEY,
    scanned_at TEXT NOT NULL
  )`);
  return db;
}
