ALTER TABLE winston.telegram_files ADD COLUMN staging_transfer_id uuid;
ALTER TABLE winston.telegram_files ADD CONSTRAINT telegram_files_staging_transfer_fk
  FOREIGN KEY (owner_id, staging_transfer_id) REFERENCES winston.artifact_transfers(owner_id, id);
CREATE INDEX artifact_transfers_delivery_idx
  ON winston.artifact_transfers (owner_id, task_id, intent_revision, artifact_id, workspace_id)
  WHERE state = 'staged';
