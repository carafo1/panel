# ════════════════════════════════════════════════════════════════════════════
# Apsamo Panel — Hetzner Cloud Terraform Deployment
# ════════════════════════════════════════════════════════════════════════════
#
#   Provisions a Hetzner Cloud VPS with Apsamo Panel pre-installed via
#   cloud-init. Zero SSH interaction required.
#
#   Usage:
#     1. Get a Hetzner Cloud API token: https://console.hetzner.cloud/
#     2. Copy terraform.tfvars.example → terraform.tfvars and fill in values
#     3. Run:
#          terraform init
#          terraform apply
#     4. Wait ~10 min for cloud-init to finish
#     5. Visit https://your-domain.com
#
#   Cost: ~€4.50/mo (CX22: 2 vCPU, 4GB RAM, 40GB disk)
# ════════════════════════════════════════════════════════════════════════════

terraform {
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
  required_version = ">= 1.0"
}

provider "hcloud" {
  token = var.hcloud_token
}

# ─── Variables ────────────────────────────────────────────────────────────
variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "brand_domain" {
  description = "Apex domain for the panel (e.g. apsamo.com)"
  type        = string
}

variable "admin_email" {
  description = "Admin login email"
  type        = string
}

variable "admin_password" {
  description = "Admin password (min 8 chars)"
  type        = string
  sensitive   = true
}

variable "server_name" {
  description = "Hetzner server name"
  type        = string
  default     = "apsamo-panel"
}

variable "server_type" {
  description = "Hetzner server type (cx22 = 2vCPU/4GB €4.50, cx32 = 4vCPU/8GB €7.55, cx42 = 8vCPU/16GB €15.11)"
  type        = string
  default     = "cx22"
}

variable "location" {
  description = "Hetzner location (nbg1, fsn1, hel1, ash, hil, sin)"
  type        = string
  default     = "nbg1"
}

variable "image" {
  description = "OS image"
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_keys" {
  description = "Names of existing Hetzner SSH keys to add to the server"
  type        = list(string)
  default     = []
}

# Optional credentials (all default to empty = demo mode)
variable "dynadot_api_key"       { type = string; default = ""; sensitive = true }
variable "dynadot_secret_key"    { type = string; default = ""; sensitive = true }
variable "stripe_secret_key"     { type = string; default = ""; sensitive = true }
variable "stripe_webhook_secret" { type = string; default = ""; sensitive = true }
variable "stripe_price_id"       { type = string; default = "" }
variable "smtp_host"             { type = string; default = "" }
variable "smtp_port"             { type = string; default = "587" }
variable "smtp_user"             { type = string; default = "" }
variable "smtp_pass"             { type = string; default = ""; sensitive = true }
variable "mailcow_api_url"       { type = string; default = "" }
variable "mailcow_api_key"       { type = string; default = ""; sensitive = true }
variable "github_client_id"      { type = string; default = "" }
variable "github_client_secret"  { type = string; default = ""; sensitive = true }
variable "github_token"          { type = string; default = ""; sensitive = true }
variable "install_mailcow"       { type = bool;   default = false }

# ─── Cloud-init template ──────────────────────────────────────────────────
locals {
  cloud_init = templatefile("${path.module}/../cloud-init/cloud-init.yaml.tpl", {
    brand_domain          = var.brand_domain
    admin_email           = var.admin_email
    admin_password        = var.admin_password
    dynadot_api_key       = var.dynadot_api_key
    dynadot_secret_key    = var.dynadot_secret_key
    stripe_secret_key     = var.stripe_secret_key
    stripe_webhook_secret = var.stripe_webhook_secret
    stripe_price_id       = var.stripe_price_id
    smtp_host             = var.smtp_host
    smtp_port             = var.smtp_port
    smtp_user             = var.smtp_user
    smtp_pass             = var.smtp_pass
    mailcow_api_url       = var.mailcow_api_url
    mailcow_api_key       = var.mailcow_api_key
    github_client_id      = var.github_client_id
    github_client_secret  = var.github_client_secret
    github_token          = var.github_token
    install_mailcow       = var.install_mailcow ? "true" : "false"
  })
}

# ─── Server ───────────────────────────────────────────────────────────────
resource "hcloud_server" "apsamo" {
  name        = var.server_name
  image       = var.image
  server_type = var.server_type
  location    = var.location
  ssh_keys    = var.ssh_keys
  user_data   = local.cloud_init

  labels = {
    project = "apsamo-panel"
    managed = "terraform"
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────
output "server_ip" {
  description = "Public IPv4 of the panel server"
  value       = hcloud_server.apsamo.ipv4_address
}

output "panel_url" {
  description = "URL to access the panel (after DNS propagates)"
  value       = "https://${var.brand_domain}"
}

output "admin_email" {
  description = "Admin login email"
  value       = var.admin_email
}

output "ssh_command" {
  description = "SSH command to connect to the server"
  value       = "ssh root@${hcloud_server.apsamo.ipv4_address}"
}

output "install_log_command" {
  description = "Tail the install log"
  value       = "ssh root@${hcloud_server.apsamo.ipv4_address} 'tail -f /var/log/apsamo-install.log'"
}

output "dns_records_to_set" {
  description = "DNS A records you need to create at your registrar"
  value = {
    "A  @    → " = hcloud_server.apsamo.ipv4_address
    "A  www  → " = hcloud_server.apsamo.ipv4_address
    "A  ns1  → " = hcloud_server.apsamo.ipv4_address
    "A  ns2  → " = hcloud_server.apsamo.ipv4_address
    "A  mail → " = hcloud_server.apsamo.ipv4_address
  }
}
