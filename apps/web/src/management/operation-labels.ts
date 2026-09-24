import type { AuthorizationRequest } from "@winston/contracts/authorization";

export const operationLabels: Record<AuthorizationRequest["operation"], string> = {
  "gmail.read": "Read email",
  "gmail.draft": "Create email drafts",
  "gmail.send": "Send email",
  "gmail.modify": "Change email",
  "calendar.list": "List calendars",
  "calendar.read": "Read calendar",
  "calendar.write": "Change calendar",
  "device.command": "Run commands",
  "device.file.read": "Read files",
  "device.file.write": "Change files",
  "device.observe": "Observe screen",
  "device.input": "Use keyboard and mouse",
  "device.application": "Control applications",
  "workspace.command": "Run commands",
  "workspace.file.read": "Read files",
  "workspace.file.write": "Change files",
};
