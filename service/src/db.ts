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
    phase TEXT,
    skip_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (repo_id, issue_number)
  )`);
  // Added after the first release; older databases gain it here.
  const jobColumns = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('jobs')").all();
  if (!jobColumns.some((c) => c.name === "phase")) db.run("ALTER TABLE jobs ADD COLUMN phase TEXT");
  db.run(`CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    full_name TEXT NOT NULL,
    installation_id INTEGER NOT NULL,
    conventions TEXT,
    conventions_hash TEXT,
    conventions_at TEXT,
    override TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs (id),
    harness TEXT NOT NULL,
    base_sha TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    result TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS phases (
    id INTEGER PRIMARY KEY,
    attempt_id INTEGER NOT NULL REFERENCES attempts (id),
    name TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    log TEXT NOT NULL DEFAULT ''
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS scan_cursors (
    repo_id INTEGER PRIMARY KEY,
    scanned_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  return db;
}
