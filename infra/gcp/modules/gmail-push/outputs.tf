output "topic" {
  description = "The full topic name, for users.watch (GMAIL_PUSH_TOPIC)."
  value       = google_pubsub_topic.gmail.id
}

output "push_service_account" {
  description = "The email in the push requests' OIDC tokens (GMAIL_PUSH_SERVICE_ACCOUNT)."
  value       = google_service_account.push.email
}

output "audience" {
  description = "The OIDC tokens' audience (GMAIL_PUSH_AUDIENCE)."
  value       = var.push_endpoint
}
