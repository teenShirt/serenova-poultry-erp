# k3s cluster VMs cloned from a cloud-init template, plus the Ansible inventory that configures them.
resource "proxmox_virtual_environment_vm" "node" {
  for_each = var.nodes

  name        = each.key
  node_name   = var.proxmox_node
  vm_id       = each.value.vm_id
  description = "Poultry Farm Manager k3s ${each.value.role} — managed by Terraform"
  tags        = ["k3s", each.value.role, "terraform"]
  on_boot     = true

  clone {
    vm_id = var.template_vm_id
    full  = true
  }

  agent {
    enabled = true
  }

  cpu {
    cores = each.value.cores
    type  = "host"
  }

  memory {
    dedicated = each.value.memory_mb
  }

  disk {
    datastore_id = var.datastore
    interface    = "scsi0"
    size         = each.value.disk_gb
    discard      = "on"
    iothread     = true
  }

  network_device {
    bridge = var.bridge
  }

  initialization {
    datastore_id = var.datastore
    ip_config {
      ipv4 {
        address = each.value.ip
        gateway = var.gateway
      }
    }
    dns {
      servers = var.dns_servers
    }
    user_account {
      username = var.admin_user
      keys     = [trimspace(var.ssh_public_key)]
    }
  }

  lifecycle {
    # Proxmox fills these in after creation; ignoring them avoids needless diffs.
    ignore_changes = [initialization[0].user_account]
  }
}

locals {
  servers = { for k, v in var.nodes : k => split("/", v.ip)[0] if v.role == "server" }
  agents  = { for k, v in var.nodes : k => split("/", v.ip)[0] if v.role == "agent" }
}

resource "local_file" "ansible_inventory" {
  filename        = "${path.module}/../../ansible/inventory/hosts.ini"
  file_permission = "0644"
  content = templatefile("${path.module}/inventory.tftpl", {
    servers    = local.servers
    agents     = local.agents
    admin_user = var.admin_user
  })
}
