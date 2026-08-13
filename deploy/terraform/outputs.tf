output "public_ip" {
  description = "Public address of the instance."
  value       = aws_instance.brickcheck.public_ip
}

output "url" {
  description = "Where the app will answer once cloud-init has finished building it."
  value       = "http://${aws_instance.brickcheck.public_ip}/"
}

output "ssh" {
  description = "SSH command for checking progress."
  value       = "ssh ec2-user@${aws_instance.brickcheck.public_ip}"
}

output "first_boot_note" {
  description = "What to expect immediately after apply."
  value       = "The image builds on first boot and takes several minutes. Watch it with: ssh ec2-user@${aws_instance.brickcheck.public_ip} 'sudo tail -f /var/log/brickcheck-setup.log'"
}
