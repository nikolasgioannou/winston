CREATE TABLE winston.responsibility_requests (
  owner_id uuid NOT NULL,
  responsibility_id uuid NOT NULL,
  task_id uuid NOT NULL,
  intent_revision integer NOT NULL,
  PRIMARY KEY (owner_id, responsibility_id),
  UNIQUE (owner_id, task_id, intent_revision),
  FOREIGN KEY (owner_id, responsibility_id) REFERENCES winston.responsibilities(owner_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES winston.tasks(owner_id, id)
);
