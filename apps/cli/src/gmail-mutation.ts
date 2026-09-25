import {
  cliGmailMutationRequestSchema,
  type CliGmailMutationRequest,
} from "@winston/contracts/cli";

type Options = {
  account?: string;
  key?: string;
  message?: string;
  id?: string;
  "message-id"?: string;
};
export function parseGmailMutation(command: CliGmailMutationRequest["command"], values: Options) {
  return cliGmailMutationRequestSchema.parse({
    version: 1,
    command,
    accountId: values.account,
    key: values.key,
    message: JSON.parse(values.message ?? "null") as unknown,
    ...(values.id === undefined ? {} : { draftId: values.id }),
    ...(values["message-id"] === undefined ? {} : { expectedMessageId: values["message-id"] }),
  });
}
