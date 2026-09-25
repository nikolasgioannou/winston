CREATE TABLE winston.device_file_writes (
  owner_id uuid NOT NULL,
  action_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  workspace_revision integer NOT NULL CHECK (workspace_revision >= 0),
  artifact_id uuid NOT NULL,
  artifact_revision integer NOT NULL CHECK (artifact_revision >= 0),
  source_action_id uuid,
  staging_transfer_id uuid,
  PRIMARY KEY (owner_id, action_id),
  UNIQUE (owner_id, transfer_id),
  FOREIGN KEY (owner_id, action_id) REFERENCES winston.actions(owner_id, id),
  FOREIGN KEY (owner_id, workspace_id) REFERENCES winston.workspaces(owner_id, id),
  FOREIGN KEY (owner_id, artifact_id) REFERENCES winston.artifacts(owner_id, id),
  FOREIGN KEY (owner_id, source_action_id) REFERENCES winston.actions(owner_id, id),
  FOREIGN KEY (owner_id, staging_transfer_id) REFERENCES winston.artifact_transfers(owner_id, id),
  CHECK ((source_action_id IS NOT NULL) <> (staging_transfer_id IS NOT NULL))
);
