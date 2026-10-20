UPDATE documents
SET source_name = 'rss'
WHERE source_name = 'readwise';

UPDATE sync_skips
SET source_name = 'rss'
WHERE source_name = 'readwise';
