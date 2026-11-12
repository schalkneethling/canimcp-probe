-- MEASUREMENT ONLY: this table exists to count D1 rows written per insert
-- into a table with three indexes. It is not the storage design, which issue
-- #1 puts out of scope. It deliberately stores no request content: no body,
-- no headers, no client-supplied strings, because the scratch Worker that
-- writes to it may be deployed publicly.
CREATE TABLE probe_records (
	id INTEGER PRIMARY KEY,
	received_at TEXT NOT NULL,
	-- The classifier's route: legacy, modern, reject, or the probe's own unparsed.
	classification_kind TEXT NOT NULL,
	-- The era the envelope claims, set for modern routes only; NULL otherwise.
	classification_era TEXT,
	reply_status INTEGER NOT NULL
);

CREATE INDEX idx_probe_records_received_at ON probe_records (received_at);
CREATE INDEX idx_probe_records_classification_kind ON probe_records (classification_kind);
CREATE INDEX idx_probe_records_classification_era ON probe_records (classification_era);
