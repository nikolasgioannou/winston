ALTER TABLE winston.telegram_files ADD COLUMN read_action_id uuid;
ALTER TABLE winston.telegram_files ADD CONSTRAINT telegram_files_read_action_fk
  FOREIGN KEY (owner_id, read_action_id) REFERENCES winston.actions(owner_id, id);
