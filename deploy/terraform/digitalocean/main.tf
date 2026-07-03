# ════════════════════════════════════════════════════════════════════════════
# Apsamo Panel — DigitalOcean Terraform Deployment
# ════════════════════════════════════════════════════════════════════════════
#
#   Provisions a DigitalOcean droplet with Apsamo Panel pre-installed via
#   cloud-init. Zero SSH interaction required.
#
#   Usage:
#     1. Get a DigitalOcean API token: https://cloud.digitalocean.com/account/api/tokens
#     2. Copy terraform.tfvars.example → terraform.tfvars and fill in values
#     3. Run:
#          terraform init
#          terraform apply
#     4. Wait ~10 min for cloud-init to finish
#     5. Visit https://your-domain.com
#
#   Cost: ~$24/mo (s-2vcpu-4gb: 2 vCPU, 4GB RAM, 80GB disk)
# ════════════════════════════════════════════════════════════════════════════

terraform {
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.30"
    }
  }
  required_version = ">= 1.0"
}

provider "digitalocean" {
  token = var.do_token
}

# ─── Variables ────────────────────────────────────────────────────────────
variable "do_token" {
  description = "DigitalOcean API token"
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

variable "droplet_name" {
  description = "Droplet name"
  type        = string
  default     = "apsamo-panel"
}

variable "droplet_size" {
  description = "Droplet size (s-2vcpu-4gb $24, s-4vcpu-8gb $48, s-8vcpu-16gb $96)"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "region" {
  description = "DO region (nyc1, nyc3, sfo3, ams3, sgp1, lon1, fra1, tor1, blr1, syd1)"
  type        = string
  default     = "nyc1"
}

variable "ssh_keys" {
  description = "List of DO SSH key IDs or fingerprints"
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

# ─── Droplet ──────────────────────────────────────────────────────────────
resource "digitalocean_droplet" "apsamo" {
  name       = var.droplet_name
  image      = "ubuntu-24-04-x64"
  size       = var.droplet_size
  region     = var.region
  ssh_keys   = var.ssh_keys
  user_data  = local.cloud_init
  monitoring = true
  tags       = ["apsamo-panel", "terraform"]
}

# ─── Firewall ─────────────────────────────────────────────────────────────
resource "digitalocean_firewall" "apsamo" {
  name        = "apsamo-panel-firewall"
  droplet_ids = [digitalocean_droplet.apsamo.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "80"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  inbound_rule {
    protocol         = "tcp"
    port_range       = "443"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "all"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}

# ─── Outputs ──────────────────────────────────────────────────────────────
output "server_ip" {
  description = "Public IPv4 of the panel server"
  value       = digitalocean_droplet.apsamo.ipv4_address
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
  value       = "ssh root@${digitalocean_droplet.apsamo.ipv4_address}"
}

output "install_log_command" {
  description = "Tail the install log"
  value       = "ssh root@${digitalocean_droplet.apsamo.ipv4_address} 'tail -f /var/log/apsamo-install.log'"
}

output "dns_records_to_set" {
  description = "DNS A records you need to create at your registrar"
  value = {
    "A  @    → " = digitalocean_droplet.apsamo.ipv4_address
    "A  www  → " = digitalocean_droplet.apsamo.ipv4_address
    "A  ns1  → " = digitalocean_droplet.apsamo.ipv4_address
    "A  ns2  → " = digitalocean_droplet.apsamo.ipv4_address
    "A  mail → " = digitalocean_droplet.apsamo.ipv4_address
  }
}
