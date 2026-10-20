UPDATE feed_items
SET publication_status = 'withdrawn'
WHERE id IN (
  SELECT older.id
  FROM feed_items older
  JOIN feed_items newer
    ON newer.document_version_id = older.document_version_id
   AND newer.id > older.id
  WHERE older.publication_status != 'withdrawn'
);
