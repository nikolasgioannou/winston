# Gmail push for production (docs/runbooks/gcp-terraform.md).

terraform {
  required_version = ">= 1.16"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.5"
    }
  }
  # State in winston-prod's S3 bucket (the Ci stack), with S3's native locking.
  backend "s3" {
    bucket       = "winston-terraform-state-766577085959"
    key          = "gcp/prod.tfstate"
    region       = "us-east-1"
    profile      = "winston-prod"
    use_lockfile = true
    encrypt      = true
  }
}

# Credentials come from gcloud's application-default login; no key files.
provider "google" {
  project = "winston-510100"
}

module "gmail_push" {
  source                  = "../modules/gmail-push"
  topic_name              = "gmail-push"
  push_endpoint           = "https://api.runwinston.com/webhooks/gmail"
  push_service_account_id = "gmail-push"
}

output "topic" {
  value = module.gmail_push.topic
}

output "push_service_account" {
  value = module.gmail_push.push_service_account
}

output "audience" {
  value = module.gmail_push.audience
}
