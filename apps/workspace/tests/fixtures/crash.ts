import { writeFileSync } from "node:fs";
import { workspaceOperationSchema } from "@winston/contracts/workspace";
import { openWorkspaceJournal } from "../../src/journal";

const root = process.argv[2];
const encoded = process.argv[3];
if (!root || !encoded) throw new Error("Missing test fixture input.");
const operation = workspaceOperationSchema.parse(JSON.parse(encoded) as unknown);
const journal = openWorkspaceJournal({ root, identity: operation.identity });
const started = journal.start(operation);
if (!started.started) throw new Error("Expected a new operation.");
writeFileSync(1, "started\n");
process.kill(process.pid, "SIGKILL");
