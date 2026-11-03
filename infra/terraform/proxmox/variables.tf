variable "proxmox_node" {
  description = "Proxmox node that hosts the VMs"
  type        = string
  default     = "pve"
}

variable "proxmox_insecure_tls" {
  description = "Accept the self-signed certificate of a home-lab Proxmox"
  type        = bool
  default     = true
}

variable "proxmox_ssh_user" {
  description = "SSH user on the Proxmox host (used to upload cloud-init snippets)"
  type        = string
  default     = "root"
}

variable "template_vm_id" {
  description = "VM id of the Ubuntu 24.04 cloud-init template to clone (see README)"
  type        = number
  default     = 9000
}

variable "datastore" {
  description = "Storage for VM disks"
  type        = string
  default     = "local-lvm"
}

variable "bridge" {
  description = "Network bridge"
  type        = string
  default     = "vmbr0"
}

variable "gateway" {
  description = "Default gateway of the lab network"
  type        = string
  default     = "192.168.1.1"
}

variable "dns_servers" {
  type    = list(string)
  default = ["1.1.1.1", "8.8.8.8"]
}

variable "ssh_public_key" {
  description = "Public key placed on every VM for the admin user"
  type        = string
}

variable "admin_user" {
  type    = string
  default = "sre"
}

variable "nodes" {
  description = "Cluster VMs: one k3s server (control plane) and workers"
  type = map(object({
    vm_id     = number
    role      = string # server | agent
    ip        = string # CIDR, e.g. 192.168.1.50/24
    cores     = number
    memory_mb = number
    disk_gb   = number
  }))
  default = {
    k3s-server-1 = { vm_id = 210, role = "server", ip = "192.168.1.50/24", cores = 2, memory_mb = 4096, disk_gb = 40 }
    k3s-agent-1  = { vm_id = 211, role = "agent", ip = "192.168.1.51/24", cores = 2, memory_mb = 4096, disk_gb = 60 }
    k3s-agent-2  = { vm_id = 212, role = "agent", ip = "192.168.1.52/24", cores = 2, memory_mb = 4096, disk_gb = 60 }
  }

  validation {
    condition     = alltrue([for n in values(var.nodes) : contains(["server", "agent"], n.role)])
    error_message = "Each node's role must be server or agent."
  }
}
