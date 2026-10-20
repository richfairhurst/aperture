import type { Database } from "bun:sqlite";

const defaultNewsRetentionDays = 3;

export type NewsRetentionResult = {
  evaluationsDeleted: number;
  documentVersionsDeleted: number;
  documentsDeleted: number;
};

export function purgeExpiredNews(
  database: Database,
  now = new Date(),
  retentionDays = defaultNewsRetentionDays,
): NewsRetentionResult {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error("NEWS_RETENTION_DAYS must be a positive number");
  }

  const cutoff = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  return database.transaction(() => {
    const expired = database
      .query<
        { id: number; document_version_id: number; document_id: number },
        [string]
      >(
        `SELECT e.id, e.document_version_id, v.document_id
         FROM evaluations e
         JOIN document_versions v ON v.id = e.document_version_id
         JOIN documents d ON d.id = v.document_id
         WHERE julianday(
                 CASE
                   WHEN d.published_date IS NULL OR length(d.published_date) <= 10
                   THEN d.created_at
                   ELSE d.published_date
                 END
               ) < julianday(?)`,
      )
      .all(cutoff);

    const summaryIds = expired.flatMap((evaluation) =>
      database
        .query<{ summary_id: number | null }, [number]>(
          "SELECT summary_id FROM feed_items WHERE evaluation_id = ? AND summary_id IS NOT NULL",
        )
        .all(evaluation.id)
        .map((row) => row.summary_id)
        .filter((summaryId): summaryId is number => summaryId !== null),
    );

    for (const summaryId of summaryIds) {
      database.query("DELETE FROM summaries WHERE id = ?").run(summaryId);
    }

    for (const evaluation of expired) {
      database.query("DELETE FROM evaluations WHERE id = ?").run(evaluation.id);
    }

    const documentVersionIds = [
      ...new Set(expired.map((evaluation) => evaluation.document_version_id)),
    ];
    const documentIds = [
      ...new Set(expired.map((evaluation) => evaluation.document_id)),
    ];
    let documentVersionsDeleted = 0;
    let documentsDeleted = 0;

    for (const documentVersionId of documentVersionIds) {
      const stillReferenced = database
        .query<{ id: number }, [number]>(
          "SELECT id FROM evaluations WHERE document_version_id = ? LIMIT 1",
        )
        .get(documentVersionId);
      if (stillReferenced) continue;

      const result = database
        .query("DELETE FROM document_versions WHERE id = ?")
        .run(documentVersionId);
      if (result.changes > 0) documentVersionsDeleted += 1;
    }

    for (const documentId of documentIds) {
      const stillHasVersions = database
        .query<{ id: number }, [number]>(
          "SELECT id FROM document_versions WHERE document_id = ? LIMIT 1",
        )
        .get(documentId);
      if (stillHasVersions) continue;

      const result = database
        .query("DELETE FROM documents WHERE id = ?")
        .run(documentId);
      if (result.changes > 0) documentsDeleted += 1;
    }

    return {
      evaluationsDeleted: expired.length,
      documentVersionsDeleted,
      documentsDeleted,
    };
  })();
}
