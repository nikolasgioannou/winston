# Gmail push notifications for one environment (docs/design.md §3, How
# change notifications arrive): Gmail publishes to a topic, and a push
# subscription delivers each notification to our webhook with an OIDC token
# we verify. Messages that keep failing go to a dead-letter topic.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
}

data "google_project" "this" {}

locals {
  # The Pub/Sub service agent mints push tokens and forwards dead letters.
  pubsub_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_project_service" "pubsub" {
  service            = "pubsub.googleapis.com"
  disable_on_destroy = false
}

resource "google_pubsub_topic" "gmail" {
  name       = var.topic_name
  depends_on = [google_project_service.pubsub]
}

# Gmail's own service account publishes the notifications.
resource "google_pubsub_topic_iam_member" "gmail_publisher" {
  topic  = google_pubsub_topic.gmail.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:gmail-api-push@system.gserviceaccount.com"
}

# The identity in the push requests' OIDC tokens; the webhook checks it.
resource "google_service_account" "push" {
  account_id   = var.push_service_account_id
  display_name = "Gmail push to ${var.push_endpoint}"
}

resource "google_service_account_iam_member" "agent_mints_tokens" {
  service_account_id = google_service_account.push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_agent
}

resource "google_pubsub_topic" "dead_letter" {
  name       = "${var.topic_name}-dead-letter"
  depends_on = [google_project_service.pubsub]
}

# Dead letters are kept a week to look at; a topic with no subscription would drop them.
resource "google_pubsub_subscription" "dead_letter" {
  name                       = "${var.topic_name}-dead-letter"
  topic                      = google_pubsub_topic.dead_letter.id
  message_retention_duration = "604800s"
  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "agent_publishes_dead_letters" {
  topic  = google_pubsub_topic.dead_letter.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_agent
}

resource "google_pubsub_subscription" "push" {
  name  = "${var.topic_name}-push"
  topic = google_pubsub_topic.gmail.id

  ack_deadline_seconds = 30
  # A notification is only a nudge to sync; the reconciliation sweep catches
  # anything older, so a day is plenty.
  message_retention_duration = "86400s"

  push_config {
    push_endpoint = var.push_endpoint
    oidc_token {
      service_account_email = google_service_account.push.email
      audience              = var.push_endpoint
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter.id
    max_delivery_attempts = 10
  }

  expiration_policy {
    ttl = ""
  }

  depends_on = [google_service_account_iam_member.agent_mints_tokens]
}

resource "google_pubsub_subscription_iam_member" "agent_acks_dead_letters" {
  subscription = google_pubsub_subscription.push.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_agent
}
