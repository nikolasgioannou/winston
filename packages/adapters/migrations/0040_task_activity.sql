CREATE INDEX task_activity_created
  ON winston.task_revisions (owner_id, created_at DESC, task_id DESC)
  WHERE revision = 0;
