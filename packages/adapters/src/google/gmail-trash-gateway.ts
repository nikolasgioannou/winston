import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { GmailTrashInput } from "@winston/contracts/gmail-trash";
import {
  createGmailStateMutationGateway,
  type GmailStateGatewayOptions,
} from "./gmail-state-mutation-gateway";

export function createGmailTrashGateway(options: GmailStateGatewayOptions) {
  const gateway = createGmailStateMutationGateway(options, "trash");
  return (credential: ServiceRequest, input: GmailTrashInput, signal: AbortSignal) =>
    gateway(credential, input, signal);
}
