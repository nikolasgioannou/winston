CREATE TABLE winston.workspace_runtimes (
  owner_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  origin text NOT NULL UNIQUE CHECK (length(origin) BETWEEN 1 AND 2048),
  PRIMARY KEY (owner_id, workspace_id),
  FOREIGN KEY (owner_id, workspace_id) REFERENCES winston.workspaces(owner_id, id)
);
