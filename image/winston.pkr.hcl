# The VM image (docs/design.md §18). Both sources run the same provisioning
# scripts; `WINSTON_TARGET` tells a script where it's running when it matters.
# - docker.local: the local Docker "VM" (arm64), `bun run image:build:local`.
# - amazon-ebs.ec2: the production AMI (x86_64), `bun run image:build:ami`.

packer {
  required_plugins {
    docker = {
      source  = "github.com/hashicorp/docker"
      version = "~> 1.1"
    }
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "~> 1.8"
    }
  }
}

variable "docker_platform" {
  type        = string
  default     = "linux/arm64"
  description = "The local image's platform. arm64 runs natively on Apple Silicon; emulated amd64 crashes Bun."
}

variable "winston_binary" {
  type        = string
  default     = "build/winston-linux-arm64"
  description = "The compiled winston CLI for the image's architecture, relative to image/."
}

variable "winstond_binary" {
  type        = string
  default     = "build/winstond-linux-arm64"
  description = "The compiled winstond for the image's architecture, relative to image/."
}

variable "version" {
  type        = string
  default     = "dev"
  description = "The baked-in binaries' version, recorded as a tag on the AMI."
}

locals {
  build_time = formatdate("YYYYMMDD-hhmmss", timestamp())
  # The order matters: ec2.sh (EC2 only) builds on the users and units.
  scripts = [
    "${path.root}/scripts/base.sh",
    "${path.root}/scripts/systemd.sh",
    "${path.root}/scripts/users.sh",
    "${path.root}/scripts/cli.sh",
    "${path.root}/scripts/winstond.sh",
    "${path.root}/scripts/ec2.sh",
  ]
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

# Canonical's latest Ubuntu 24.04 LTS for x86_64 (the same Chrome build real
# users run, §10). Credentials come from the environment: the winston-prod SSO
# profile locally, GitHub's OIDC role in CI. Packer starts a temporary
# instance in the account's default VPC and SSHes in with a temporary key.
source "amazon-ebs" "ec2" {
  region        = "us-east-1"
  instance_type = "t3a.medium"
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["099720109477"]
    most_recent = true
  }
  ssh_username    = "ubuntu"
  ami_name        = "winston-vm-${local.build_time}"
  ami_description = "Winston VM ${var.version}"
  encrypt_boot    = true
  # Instances launched from it require IMDSv2.
  imds_support = "v2.0"
  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 12
    volume_type           = "gp3"
    delete_on_termination = true
  }
  tags = {
    Name      = "winston-vm"
    Version   = var.version
    SourceAmi = "{{ .SourceAMI }}"
    BuiltBy   = "packer"
  }
  snapshot_tags = {
    Name    = "winston-vm"
    Version = var.version
  }
}

build {
  sources = ["source.docker.local", "source.amazon-ebs.ec2"]

  provisioner "file" {
    source      = "${path.root}/${var.winstond_binary}"
    destination = "/tmp/winstond"
  }

  provisioner "file" {
    source      = "${path.root}/${var.winston_binary}"
    destination = "/tmp/winston"
  }

  # The Docker build runs as root; on EC2, Packer connects as ubuntu.
  provisioner "shell" {
    only             = ["docker.local"]
    environment_vars = ["WINSTON_TARGET=docker", "DEBIAN_FRONTEND=noninteractive"]
    scripts          = local.scripts
  }

  provisioner "shell" {
    only             = ["amazon-ebs.ec2"]
    environment_vars = ["WINSTON_TARGET=ec2", "DEBIAN_FRONTEND=noninteractive"]
    execute_command  = "chmod +x {{ .Path }}; sudo -E {{ .Vars }} {{ .Path }}"
    scripts          = local.scripts
  }

  post-processor "docker-tag" {
    only       = ["docker.local"]
    repository = "winston-vm"
    tags       = ["local"]
  }

  # Read by scripts/image-build-ami.ts to record the new AMI's id.
  post-processor "manifest" {
    only       = ["amazon-ebs.ec2"]
    output     = "${path.root}/build/ami-manifest.json"
    strip_path = true
  }
}
