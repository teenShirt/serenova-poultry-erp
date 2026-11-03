terraform {
  required_version = ">= 1.6"
  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.83"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

# Credentials come from the environment, never from files in git:
#   export PROXMOX_VE_ENDPOINT=https://pve.lan:8006/
#   export PROXMOX_VE_API_TOKEN='terraform@pve!k3s=<secret>'
provider "proxmox" {
  insecure = var.proxmox_insecure_tls
  ssh {
    agent    = true
    username = var.proxmox_ssh_user
  }
}
