variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "eu-west-2"
}

variable "admin_cidr" {
  description = "CIDR allowed to reach SSH. Your own address as x.x.x.x/32. Home broadband addresses change, so expect to update this."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.admin_cidr))
    error_message = "admin_cidr must be a CIDR block, for example 203.0.113.7/32."
  }
}

variable "key_name" {
  description = "Name of an existing EC2 key pair, for SSH access."
  type        = string
}

variable "instance_type" {
  description = "Graviton (arm64) instance type. t4g.micro fits the free tier but leaves little headroom once OpenCV has decoded two photos."
  type        = string
  default     = "t4g.small"
}

variable "repo_url" {
  description = "Git repository cloned and built on the instance."
  type        = string
  default     = "https://github.com/Nessaek/brick-check.git"
}

variable "api_key_parameter" {
  description = "Name of the SSM SecureString parameter holding the Anthropic API key. The value never passes through Terraform."
  type        = string
  default     = "/brickcheck/anthropic_api_key"
}

variable "app_password_parameter" {
  description = "Name of the SSM SecureString parameter holding the shared app password."
  type        = string
  default     = "/brickcheck/app_password"
}

variable "domain" {
  description = "Hostname to serve on, if you own one and have pointed it at this instance. Leave empty to use <public-ip>.sslip.io, which resolves to the instance and still gets a real Let's Encrypt certificate."
  type        = string
  default     = ""
}
