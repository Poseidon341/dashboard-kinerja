-- Tahap awal hanya membuat metadata impor. Tidak ada tabel fakta/domain atau data bisnis.
CREATE TABLE IF NOT EXISTS dashboard_source_registry (
  source_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_key VARCHAR(100) NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  source_location VARCHAR(1024) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_dashboard_source_registry_source_key (source_key),
  KEY idx_dashboard_source_registry_active (is_active, source_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_batch (
  batch_id CHAR(36) NOT NULL PRIMARY KEY,
  source_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL,
  source_checksum CHAR(64) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  rows_read BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_staged BIGINT UNSIGNED NOT NULL DEFAULT 0,
  rows_rejected BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_dashboard_import_batch_source FOREIGN KEY (source_id) REFERENCES dashboard_source_registry (source_id),
  KEY idx_dashboard_import_batch_source_started (source_id, started_at),
  KEY idx_dashboard_import_batch_status_started (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_object (
  object_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_name VARCHAR(255) NOT NULL,
  object_type VARCHAR(32) NOT NULL,
  source_checksum CHAR(64) NULL,
  source_row_count BIGINT UNSIGNED NULL,
  metadata JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_dashboard_import_object_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  KEY idx_dashboard_import_object_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_issue (
  issue_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  issue_code VARCHAR(100) NOT NULL,
  object_name VARCHAR(255) NULL,
  source_row_number BIGINT UNSIGNED NULL,
  field_name VARCHAR(255) NULL,
  safe_message VARCHAR(1000) NOT NULL,
  context JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_dashboard_import_issue_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  KEY idx_dashboard_import_issue_batch_severity (batch_id, severity),
  KEY idx_dashboard_import_issue_code (issue_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
