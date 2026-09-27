# The VM image (docs/design.md §18). Every source runs the same provisioning
# scripts; `WINSTON_TARGET` tells a script where it's running when it matters.
# Today there's one source, the local Docker "VM". The production AMI
# (amazon-ebs) joins in M4.

packer {
  required_plugins {
    docker = {
      source  = "github.com/hashicorp/docker"
      version = "~> 1.1"
    }
  }
}

variable "docker_platform" {
  type        = string
  default     = "linux/arm64"
  description = "The local image's platform. arm64 runs natively on Apple Silicon; emulated amd64 crashes Bun."
}

source "docker" "local" {
  image    = "ubuntu:24.04"
  platform = var.docker_platform
  commit   = true
  # systemd runs as PID 1 and shuts down on SIGRTMIN+3 (validated in §18).
  changes = [
    "ENV container=docker",
    "STOPSIGNAL SIGRTMIN+3",
    "CMD [\"/sbin/init\"]",
  ]
}

build {
  sources = ["source.docker.local"]

  provisioner "shell" {
    environment_vars = ["WINSTON_TARGET=docker", "DEBIAN_FRONTEND=noninteractive"]
    scripts = [
      "${path.root}/scripts/base.sh",
      "${path.root}/scripts/systemd.sh",
      "${path.root}/scripts/users.sh",
    ]
  }

  post-processor "docker-tag" {
    repository = "winston-vm"
    tags       = ["local"]
  }
}
