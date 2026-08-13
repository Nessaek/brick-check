output "public_ip" {
  description = "Public address of the instance."
  value       = aws_instance.brickcheck.public_ip
}

output "url" {
  description = "Where the app answers once cloud-init has finished. Certificate issuance adds a few seconds on first request."
  value       = var.domain != "" ? "https://${var.domain}/" : "https://${aws_instance.brickcheck.public_ip}.sslip.io/"
}

output "ssh" {
  description = "SSH command for checking progress."
  value       = "ssh ec2-user@${aws_instance.brickcheck.public_ip}"
}

output "first_boot_note" {
  description = "What to expect immediately after apply."
  value       = "The image builds on first boot and takes several minutes. Watch it with: ssh ec2-user@${aws_instance.brickcheck.public_ip} 'sudo tail -f /var/log/brickcheck-setup.log'"
}
