import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";

const defaultDatabasePath = resolve(process.cwd(), "data/aperture.sqlite");
const migrationsDirectory = new URL("../migrations/", import.meta.url);

type AppliedMigration = {
  name: string;
};

export async function openDatabase(
  databasePath = process.env.DATABASE_PATH ?? defaultDatabasePath,
): Promise<Database> {
  if (databasePath !== ":memory:") {
    await mkdir(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  database.run("PRAGMA busy_timeout = 5000");
  database.run("PRAGMA foreign_keys = ON");
  await applyMigrations(database);
  return database;
}

export async function applyMigrations(database: Database): Promise<void> {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const appliedMigrations = new Set(
    database
      .query<AppliedMigration, []>(
        "SELECT name FROM schema_migrations ORDER BY name",
      )
      .all()
      .map((migration) => migration.name),
  );

  const migrationFiles = (
    await Array.fromAsync(
      new Bun.Glob("*.sql").scan({ cwd: migrationsDirectory.pathname }),
    )
  ).sort();

  for (const migrationName of migrationFiles) {
    if (appliedMigrations.has(migrationName)) {
      continue;
    }

    const migrationUrl = new URL(migrationName, migrationsDirectory);
    const migrationSql = await Bun.file(migrationUrl).text();

    database.transaction(() => {
      database.exec(migrationSql);
      database
        .query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(migrationName, new Date().toISOString());
    })();
  }
}
