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
  // Columns added after the first release; older databases gain them here.
  const addColumn = (table: string, column: string, type: string) => {
    const columns = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(table);
    if (!columns.some((c) => c.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  addColumn("jobs", "phase", "TEXT");
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
  addColumn("attempts", "issue", "TEXT");
  addColumn("phases", "output", "TEXT");
  addColumn("attempts", "commits", "TEXT NOT NULL DEFAULT '[]'");
  addColumn("attempts", "branch", "TEXT");
  addColumn("attempts", "pr_url", "TEXT");
  // A git bundle of base_sha..HEAD after each commit, so a resumed attempt restores the commits with their SHAs.
  addColumn("attempts", "bundle", "BLOB");
  // The attempt a resumed attempt continued; null for a fresh one. The resumed phase is derived from its phases.
  addColumn("attempts", "resumed_from", "INTEGER");
  addColumn("jobs", "resume_from", "INTEGER");
  db.run(`CREATE TABLE IF NOT EXISTS scan_cursors (
    repo_id INTEGER PRIMARY KEY,
    scanned_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS deliveries (
    guid TEXT PRIMARY KEY,
    delivered_at TEXT NOT NULL
  )`);
  return db;
}
