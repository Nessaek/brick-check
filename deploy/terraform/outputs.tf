locals {
  # With an Elastic IP the instance attribute can lag behind the address the
  # box actually answers on, so the allocation is the source of truth.
  public_address = var.use_elastic_ip ? aws_eip.brickcheck[0].public_ip : aws_instance.brickcheck.public_ip
}

output "public_ip" {
  description = "Public address of the instance."
  value       = local.public_address
}

output "url" {
  description = "Where the app answers once cloud-init has finished. Certificate issuance adds a few seconds on first request."
  value       = var.domain != "" ? "https://${var.domain}/" : "https://${local.public_address}.sslip.io/"
}

output "ssh" {
  description = "SSH command for checking progress."
  value       = "ssh ec2-user@${local.public_address}"
}

output "first_boot_note" {
  description = "What to expect immediately after apply."
  value       = "The image builds on first boot and takes several minutes. Watch it with: ssh ec2-user@${local.public_address} 'sudo tail -f /var/log/brickcheck-setup.log'"
}
