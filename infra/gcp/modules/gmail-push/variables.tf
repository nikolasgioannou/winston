variable "topic_name" {
  description = "The topic Gmail publishes to, e.g. gmail-push."
  type        = string
}

variable "push_endpoint" {
  description = "Our webhook, e.g. https://api.runwinston.com/webhooks/gmail. Also the OIDC token's audience."
  type        = string
}

variable "push_service_account_id" {
  description = "The account id of the service account that signs push requests."
  type        = string
}
