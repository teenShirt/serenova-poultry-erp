output "server_ips" {
  description = "k3s control-plane addresses"
  value       = local.servers
}

output "agent_ips" {
  description = "k3s worker addresses"
  value       = local.agents
}
