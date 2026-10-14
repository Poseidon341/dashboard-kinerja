-- Additive, per-position mapping decisions tied to the office master snapshot used.
CREATE TABLE IF NOT EXISTS dashboard_stg_position_office_mapping (
  stg_position_id BIGINT UNSIGNED NOT NULL,
  master_source_object_id BIGINT UNSIGNED NOT NULL,
  office_id BIGINT UNSIGNED NULL,
  office_version_id BIGINT UNSIGNED NULL,
  mapping_status VARCHAR(24) NOT NULL,
  PRIMARY KEY (stg_position_id, master_source_object_id),
  KEY idx_stg_position_office_mapping_source_object (master_source_object_id),
  KEY idx_stg_position_office_mapping_office (office_id),
  KEY idx_stg_position_office_mapping_version (office_version_id),
  CONSTRAINT fk_stg_position_office_mapping_position FOREIGN KEY (stg_position_id) REFERENCES dashboard_stg_position_row (stg_position_id),
  CONSTRAINT fk_stg_position_office_mapping_source FOREIGN KEY (master_source_object_id) REFERENCES dashboard_import_object (object_id),
  CONSTRAINT fk_stg_position_office_mapping_office FOREIGN KEY (office_id) REFERENCES dashboard_dim_office (office_id),
  CONSTRAINT fk_stg_position_office_mapping_version FOREIGN KEY (office_version_id) REFERENCES dashboard_dim_office_version (office_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
