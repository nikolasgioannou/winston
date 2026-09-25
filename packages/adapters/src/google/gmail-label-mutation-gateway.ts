import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { GmailLabelMutationInput } from "@winston/contracts/gmail-label-mutations";
import {
  createGmailStateMutationGateway,
  type GmailStateGatewayOptions,
} from "./gmail-state-mutation-gateway";

export function createGmailLabelMutationGateway(options: GmailStateGatewayOptions) {
  const gateway = createGmailStateMutationGateway(options, "labels");
  return (credential: ServiceRequest, input: GmailLabelMutationInput, signal: AbortSignal) =>
    gateway(credential, input, signal);
}
