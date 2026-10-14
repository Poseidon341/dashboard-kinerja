-- Additive business schema. Requires metadata foundation from 001_import_metadata.sql.
-- No business rows are inserted by this migration.
CREATE TABLE IF NOT EXISTS dashboard_import_batch_detail (
  batch_id CHAR(36) NOT NULL PRIMARY KEY,
  parser_version VARCHAR(64) NOT NULL,
  source_modified_at DATETIME(3) NULL,
  source_size_bytes BIGINT UNSIGNED NULL,
  validation_summary JSON NULL,
  CONSTRAINT fk_batch_detail_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_object_identity (
  object_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_key VARCHAR(255) NOT NULL,
  UNIQUE KEY uq_object_identity_batch_key (batch_id, object_key),
  KEY idx_object_identity_batch (batch_id),
  CONSTRAINT fk_object_identity_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_object_identity_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_import_idempotency (
  idempotency_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_id BIGINT UNSIGNED NOT NULL,
  source_checksum CHAR(64) NOT NULL,
  parser_version VARCHAR(64) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_import_content_parser (source_id, source_checksum, parser_version),
  UNIQUE KEY uq_import_idempotency_batch (batch_id),
  CONSTRAINT fk_idempotency_source FOREIGN KEY (source_id) REFERENCES dashboard_source_registry (source_id),
  CONSTRAINT fk_idempotency_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_domain_publication (
  domain_key VARCHAR(64) NOT NULL,
  scope_key VARCHAR(128) NOT NULL DEFAULT 'default',
  batch_id CHAR(36) NULL,
  publication_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
  published_at DATETIME(3) NULL,
  PRIMARY KEY (domain_key, scope_key),
  KEY idx_publication_batch (batch_id),
  CONSTRAINT fk_publication_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_domain_publication_history (
  publication_event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_key VARCHAR(64) NOT NULL,
  scope_key VARCHAR(128) NOT NULL,
  previous_batch_id CHAR(36) NULL,
  new_batch_id CHAR(36) NOT NULL,
  publication_version BIGINT UNSIGNED NOT NULL,
  action VARCHAR(16) NOT NULL,
  actor VARCHAR(128) NULL,
  reason VARCHAR(500) NULL,
  event_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_publication_event_version (domain_key, scope_key, publication_version),
  KEY idx_publication_history_scope_time (domain_key, scope_key, event_at),
  CONSTRAINT fk_publication_history_previous FOREIGN KEY (previous_batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_publication_history_new FOREIGN KEY (new_batch_id) REFERENCES dashboard_import_batch (batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_date (
  calendar_date DATE NOT NULL PRIMARY KEY,
  calendar_year SMALLINT UNSIGNED NOT NULL,
  calendar_month TINYINT UNSIGNED NOT NULL,
  calendar_day TINYINT UNSIGNED NOT NULL,
  month_start DATE NOT NULL,
  month_end DATE NOT NULL,
  KEY idx_dim_date_month (calendar_year, calendar_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_office (
  office_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_system VARCHAR(50) NOT NULL,
  source_code VARCHAR(32) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_office_source_code (source_system, source_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_office_version (
  office_version_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  office_id BIGINT UNSIGNED NOT NULL,
  office_type VARCHAR(32) NULL,
  office_name VARCHAR(255) NULL,
  area_name VARCHAR(255) NULL,
  branch_class VARCHAR(100) NULL,
  rural_urban VARCHAR(100) NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  source_object_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_office_version_observation (office_id, observed_at),
  KEY idx_office_version_type_area_observed (office_type, area_name, observed_at),
  CONSTRAINT fk_office_version_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_office_version_object FOREIGN KEY (source_object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_office_relationship (
  relationship_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  child_office_id BIGINT UNSIGNED NOT NULL,
  parent_office_id BIGINT UNSIGNED NOT NULL,
  relationship_type VARCHAR(32) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  verification_status VARCHAR(24) NOT NULL,
  evidence_text VARCHAR(1000) NULL,
  source_object_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_office_relationship_snapshot (child_office_id, parent_office_id, relationship_type, observed_at),
  KEY idx_office_relationship_child (child_office_id, observed_at),
  KEY idx_office_relationship_parent (parent_office_id, observed_at),
  CONSTRAINT fk_office_relationship_child FOREIGN KEY (child_office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_office_relationship_parent FOREIGN KEY (parent_office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_office_relationship_object FOREIGN KEY (source_object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_segment (
  segment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_label VARCHAR(128) NOT NULL,
  UNIQUE KEY uq_segment_source_label (source_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_product (
  product_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_label VARCHAR(128) NOT NULL,
  UNIQUE KEY uq_product_source_label (source_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_rka_category (
  rka_category_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_system VARCHAR(50) NOT NULL,
  source_category VARCHAR(255) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  source_object_id BIGINT UNSIGNED NULL,
  KEY idx_rka_category_observed (source_system, source_category, observed_at),
  CONSTRAINT fk_rka_category_object FOREIGN KEY (source_object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_rka_metric_mapping (
  mapping_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rka_category_id BIGINT UNSIGNED NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  segment_id BIGINT UNSIGNED NULL,
  mapping_status VARCHAR(24) NOT NULL,
  decision_reference VARCHAR(255) NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  KEY idx_rka_mapping_lookup (rka_category_id, mapping_status, observed_at),
  KEY idx_rka_mapping_metric (metric_key, mapping_status),
  CONSTRAINT fk_rka_mapping_category FOREIGN KEY (rka_category_id) REFERENCES dashboard_dim_rka_category (rka_category_id),
  CONSTRAINT fk_rka_mapping_product FOREIGN KEY (product_id) REFERENCES dashboard_dim_product (product_id),
  CONSTRAINT fk_rka_mapping_segment FOREIGN KEY (segment_id) REFERENCES dashboard_dim_segment (segment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_rmft (
  rmft_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_system VARCHAR(50) NOT NULL,
  pn VARCHAR(32) NOT NULL,
  rmft_name VARCHAR(255) NULL,
  job_grade VARCHAR(64) NULL,
  job_title VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_rmft_source_pn (source_system, pn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_rmft_assignment (
  assignment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  rmft_id BIGINT UNSIGNED NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  source_unit_code VARCHAR(32) NULL,
  mapping_status VARCHAR(24) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  observed_at DATETIME(3) NOT NULL,
  source_object_id BIGINT UNSIGNED NULL,
  KEY idx_rmft_assignment_person (rmft_id, valid_from),
  KEY idx_rmft_assignment_office (office_id, valid_from),
  CONSTRAINT fk_rmft_assignment_rmft FOREIGN KEY (rmft_id) REFERENCES dashboard_dim_rmft (rmft_id),
  CONSTRAINT fk_rmft_assignment_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_rmft_assignment_object FOREIGN KEY (source_object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_dim_appraisal_metric (
  appraisal_metric_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  source_header VARCHAR(255) NOT NULL,
  metric_key VARCHAR(100) NOT NULL,
  value_unit VARCHAR(64) NULL,
  metric_type VARCHAR(32) NULL,
  observed_at DATETIME(3) NOT NULL,
  valid_from DATE NULL,
  valid_to DATE NULL,
  UNIQUE KEY uq_appraisal_metric_observed (metric_key, observed_at),
  KEY idx_appraisal_metric_header (source_header)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_position_row (
  stg_position_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  raw_record LONGTEXT NOT NULL,
  source_position_text VARCHAR(32) NULL,
  parsed_position_date DATE NULL,
  source_segment VARCHAR(128) NULL,
  source_product VARCHAR(128) NULL,
  source_branch_label VARCHAR(255) NULL,
  source_office_label VARCHAR(255) NULL,
  source_account_count_text VARCHAR(64) NULL,
  parsed_account_count BIGINT NULL,
  source_balance_text VARCHAR(128) NULL,
  parsed_balance DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_stg_position_source_row (object_id, source_row_number),
  KEY idx_stg_position_batch_status (batch_id, parse_status),
  CONSTRAINT fk_stg_position_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_position_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_office_row (
  stg_office_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  raw_record LONGTEXT NOT NULL,
  source_code_text VARCHAR(64) NULL,
  source_name VARCHAR(255) NULL,
  source_type VARCHAR(64) NULL,
  source_main_branch_code VARCHAR(64) NULL,
  source_area VARCHAR(255) NULL,
  source_class VARCHAR(100) NULL,
  source_rural_urban VARCHAR(100) NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_stg_office_source_row (object_id, source_row_number),
  KEY idx_stg_office_batch_status (batch_id, mapping_status),
  CONSTRAINT fk_stg_office_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_office_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_rmft_row (
  stg_rmft_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  raw_record LONGTEXT NOT NULL,
  source_pn VARCHAR(64) NULL,
  source_name VARCHAR(255) NULL,
  source_jg VARCHAR(64) NULL,
  source_job_title VARCHAR(255) NULL,
  source_unit_code VARCHAR(64) NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_stg_rmft_source_row (object_id, source_row_number),
  KEY idx_stg_rmft_batch_mapping (batch_id, mapping_status),
  CONSTRAINT fk_stg_rmft_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_rmft_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_rka_row (
  stg_rka_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  source_no_urut VARCHAR(64) NULL,
  source_rka_key VARCHAR(255) NULL,
  source_category VARCHAR(255) NULL,
  source_unit_code VARCHAR(64) NULL,
  raw_month_values JSON NULL,
  raw_record LONGTEXT NOT NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_stg_rka_source_row (object_id, source_row_number),
  KEY idx_stg_rka_batch_category (batch_id, source_category),
  CONSTRAINT fk_stg_rka_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_rka_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_prognosis_row (
  stg_prognosis_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  sheet_name VARCHAR(128) NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  source_range VARCHAR(64) NULL,
  header_levels JSON NULL,
  raw_row LONGTEXT NOT NULL,
  row_status VARCHAR(24) NOT NULL,
  ingested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_stg_prognosis_source_row (object_id, source_row_number),
  KEY idx_stg_prognosis_batch_sheet (batch_id, sheet_name, source_row_number),
  CONSTRAINT fk_stg_prognosis_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_prognosis_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_stg_appraisal_row (
  stg_appraisal_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_type VARCHAR(32) NULL,
  source_sheet VARCHAR(255) NULL,
  source_period DATE NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  header_fingerprint CHAR(64) NULL,
  raw_record LONGTEXT NOT NULL,
  schema_status VARCHAR(24) NOT NULL,
  ingested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_stg_appraisal_source_row (object_id, source_row_number),
  KEY idx_stg_appraisal_batch_period (batch_id, source_period, source_type),
  CONSTRAINT fk_stg_appraisal_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_stg_appraisal_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_position_daily (
  position_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  position_date DATE NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  segment_id BIGINT UNSIGNED NULL,
  product_id BIGINT UNSIGNED NULL,
  source_segment_label VARCHAR(128) NULL,
  source_product_label VARCHAR(128) NULL,
  source_branch_label VARCHAR(255) NULL,
  source_office_label VARCHAR(255) NULL,
  source_account_count_text VARCHAR(64) NULL,
  account_count BIGINT NULL,
  source_balance_text VARCHAR(128) NULL,
  balance DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  parse_status VARCHAR(24) NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_position_source_row (object_id, source_row_number),
  KEY idx_position_date_segment_product (position_date, segment_id, product_id),
  KEY idx_position_office_date (office_id, position_date),
  KEY idx_position_batch (batch_id),
  CONSTRAINT fk_position_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_position_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_position_date FOREIGN KEY (position_date) REFERENCES dashboard_dim_date (calendar_date),
  CONSTRAINT fk_position_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_position_segment FOREIGN KEY (segment_id) REFERENCES dashboard_dim_segment (segment_id),
  CONSTRAINT fk_position_product FOREIGN KEY (product_id) REFERENCES dashboard_dim_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_rka_target (
  rka_target_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  rka_category_id BIGINT UNSIGNED NULL,
  target_month DATE NOT NULL,
  source_target_text VARCHAR(128) NULL,
  target_value DECIMAL(38,15) NULL,
  amount_unit_code VARCHAR(24) NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_rka_target_source_month (object_id, source_row_number, target_month),
  KEY idx_rka_target_month_category_office (target_month, rka_category_id, office_id),
  KEY idx_rka_target_office_month (office_id, target_month),
  KEY idx_rka_target_batch (batch_id),
  CONSTRAINT fk_rka_target_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_rka_target_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_rka_target_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_rka_target_category FOREIGN KEY (rka_category_id) REFERENCES dashboard_dim_rka_category (rka_category_id),
  CONSTRAINT fk_rka_target_month FOREIGN KEY (target_month) REFERENCES dashboard_dim_date (calendar_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_prognosis_value (
  prognosis_value_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  sheet_name VARCHAR(128) NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  source_column_number SMALLINT UNSIGNED NULL,
  source_cell_address VARCHAR(32) NOT NULL,
  group_label_raw VARCHAR(255) NULL,
  group_type_raw VARCHAR(128) NULL,
  metric_label_raw VARCHAR(255) NULL,
  period_label_raw VARCHAR(255) NULL,
  raw_cell_value LONGTEXT NULL,
  raw_value_type VARCHAR(32) NULL,
  numeric_value DECIMAL(38,15) NULL,
  cached_formula_result TINYINT(1) NULL,
  row_kind VARCHAR(24) NOT NULL DEFAULT 'unknown',
  amount_unit_code VARCHAR(24) NULL,
  parse_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_prognosis_object_cell (object_id, source_cell_address),
  KEY idx_prognosis_batch_sheet_row (batch_id, sheet_name, source_row_number),
  KEY idx_prognosis_sheet_metric_period (sheet_name, metric_label_raw, period_label_raw),
  CONSTRAINT fk_prognosis_value_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_prognosis_value_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_appraisal_snapshot (
  appraisal_snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  batch_id CHAR(36) NOT NULL,
  object_id BIGINT UNSIGNED NOT NULL,
  source_row_number BIGINT UNSIGNED NOT NULL,
  source_period DATE NULL,
  source_type VARCHAR(32) NULL,
  pn VARCHAR(32) NULL,
  rmft_name VARCHAR(255) NULL,
  source_kc_code VARCHAR(32) NULL,
  office_id BIGINT UNSIGNED NULL,
  source_unit_code VARCHAR(32) NULL,
  source_unit_name VARCHAR(255) NULL,
  job_title VARCHAR(255) NULL,
  job_grade VARCHAR(64) NULL,
  score_raw VARCHAR(128) NULL,
  score_value DECIMAL(38,15) NULL,
  tier_raw VARCHAR(64) NULL,
  tier_number TINYINT UNSIGNED NULL,
  raw_record LONGTEXT NOT NULL,
  mapping_status VARCHAR(24) NOT NULL,
  UNIQUE KEY uq_appraisal_snapshot_source_row (object_id, source_row_number),
  KEY idx_appraisal_period_source_pn (source_period, source_type, pn),
  KEY idx_appraisal_office_period (office_id, source_period),
  KEY idx_appraisal_batch (batch_id),
  CONSTRAINT fk_appraisal_snapshot_batch FOREIGN KEY (batch_id) REFERENCES dashboard_import_batch (batch_id),
  CONSTRAINT fk_appraisal_snapshot_object FOREIGN KEY (object_id) REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_appraisal_snapshot_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
-- statement-break
CREATE TABLE IF NOT EXISTS dashboard_fact_appraisal_metric (
  appraisal_metric_value_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  appraisal_snapshot_id BIGINT UNSIGNED NOT NULL,
  appraisal_metric_id BIGINT UNSIGNED NOT NULL,
  target_raw VARCHAR(128) NULL,
  target_value DECIMAL(38,15) NULL,
  actual_raw VARCHAR(128) NULL,
  actual_value DECIMAL(38,15) NULL,
  realization_raw VARCHAR(128) NULL,
  realization_value DECIMAL(38,15) NULL,
  score_raw VARCHAR(128) NULL,
  score_value DECIMAL(38,15) NULL,
  UNIQUE KEY uq_appraisal_metric_snapshot (appraisal_snapshot_id, appraisal_metric_id),
  KEY idx_appraisal_metric_id (appraisal_metric_id),
  CONSTRAINT fk_appraisal_metric_snapshot FOREIGN KEY (appraisal_snapshot_id) REFERENCES dashboard_fact_appraisal_snapshot (appraisal_snapshot_id),
  CONSTRAINT fk_appraisal_metric_definition FOREIGN KEY (appraisal_metric_id) REFERENCES dashboard_dim_appraisal_metric (appraisal_metric_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
