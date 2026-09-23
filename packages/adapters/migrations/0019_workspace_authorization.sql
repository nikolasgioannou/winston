ALTER TABLE winston.authorization_rules
  DROP CONSTRAINT authorization_rules_kind_check;
--> statement-breakpoint
ALTER TABLE winston.authorization_rules
  ADD CONSTRAINT authorization_rules_kind_check CHECK (kind IN ('connection', 'device', 'workspace'));
