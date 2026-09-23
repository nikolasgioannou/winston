import type { AuthorizationRequest } from "@winston/contracts/authorization";
import type { Connection } from "@winston/contracts/connections";
import type { DatabaseTransaction } from "./owners";
import { connectionRepository } from "./connections";
import { deviceRepository } from "./devices";
import { credentialRepository } from "./credentials";
import { findWorkspace } from "./workspace-record";

const deviceCapabilities = {
  "device.command": "command",
  "device.file.read": "file.read",
  "device.file.write": "file.write",
  "device.observe": "observe",
  "device.input": "input",
  "device.application": "application",
} as const;

const googleScopeNames = {
  "gmail.read": ["gmail.modify", "gmail.readonly"],
  "gmail.draft": ["gmail.modify", "gmail.compose"],
  "gmail.send": ["gmail.modify", "gmail.compose", "gmail.send"],
  "gmail.modify": ["gmail.modify"],
  "calendar.list": [
    "calendar",
    "calendar.readonly",
    "calendar.calendarlist",
    "calendar.calendarlist.readonly",
  ],
  "calendar.read": ["calendar", "calendar.readonly", "calendar.events", "calendar.events.readonly"],
  "calendar.write": ["calendar", "calendar.events"],
} as const;

function granted(connection: Connection, operation: keyof typeof googleScopeNames) {
  if (operation.startsWith("gmail.") && connection.scopes.includes("https://mail.google.com/"))
    return true;
  return googleScopeNames[operation].some((scope) =>
    connection.scopes.includes(`https://www.googleapis.com/auth/${scope}`),
  );
}

export async function authorizationResource(
  transaction: DatabaseTransaction,
  ownerId: string,
  request: AuthorizationRequest,
  requireAvailable = true,
): Promise<number | null> {
  const { target, operation } = request;

  if (target.kind === "workspace") {
    if (
      target.resource !== null ||
      !["workspace.command", "workspace.file.read", "workspace.file.write"].includes(operation)
    )
      return null;
    const workspace = await findWorkspace(transaction, ownerId, target.id, true);
    return workspace && (!requireAvailable || workspace.state === "active")
      ? workspace.revision
      : null;
  }

  if (target.kind === "device") {
    if (target.resource !== null || !(operation in deviceCapabilities)) return null;
    const device = await deviceRepository(transaction, ownerId).find(target.id);
    const capability = deviceCapabilities[operation as keyof typeof deviceCapabilities];
    return device &&
      (!requireAvailable || (!device.revoked && device.capabilities.includes(capability)))
      ? device.revision
      : null;
  }

  if (!(operation in googleScopeNames)) return null;
  const connection = await connectionRepository(transaction, ownerId).find(target.id);
  if (!connection || !operation.startsWith(`${connection.service}.`)) return null;
  if (
    requireAvailable &&
    (!["connected", "limited"].includes(connection.status) ||
      !granted(connection, operation as keyof typeof googleScopeNames))
  )
    return null;
  if (
    requireAvailable &&
    !(await credentialRepository(transaction, ownerId).find(target.id))?.encrypted
  )
    return null;

  if (connection.service === "gmail" && target.resource !== null) return null;
  if (operation === "calendar.list" && target.resource !== null) return null;
  if (
    requireAvailable &&
    target.resource !== null &&
    !connection.calendars.includes(target.resource)
  )
    return null;
  return connection.revision;
}

export function broadDeviceAuthority(operation: AuthorizationRequest["operation"]) {
  return ["device.command", "device.file.write", "device.input", "device.application"].includes(
    operation,
  );
}
