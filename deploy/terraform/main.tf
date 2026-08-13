terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Latest Amazon Linux 2023 for arm64. Published by AWS as a public SSM
# parameter, so there is no hard-coded AMI id to go stale.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_vpc" "default" {
  default = true
}

resource "aws_security_group" "brickcheck" {
  name_prefix = "brickcheck-"
  description = "BrickCheck: SSH from the operator only, HTTP from anywhere"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH, restricted to the operator's address"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Outbound, for the Anthropic API and package installs"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "brickcheck" }

  lifecycle {
    create_before_destroy = true
  }
}

# The instance reads its secrets from SSM at boot. They are deliberately not
# Terraform variables: every value Terraform touches is written to state in
# plaintext, so an API key passed through here would end up in the state file
# and in any backend or repo holding it. Create the parameters out-of-band
# (see README.md) and Terraform only ever learns their names.
resource "aws_iam_role" "brickcheck" {
  name_prefix = "brickcheck-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "read_secrets" {
  name_prefix = "brickcheck-secrets-"
  role        = aws_iam_role.brickcheck.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          "arn:aws:ssm:${var.region}:*:parameter${var.api_key_parameter}",
          "arn:aws:ssm:${var.region}:*:parameter${var.app_password_parameter}",
        ]
      },
      {
        # SecureString parameters are encrypted with the account's default
        # SSM key; decrypting them needs an explicit kms:Decrypt.
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "brickcheck" {
  name_prefix = "brickcheck-"
  role        = aws_iam_role.brickcheck.name
}

resource "aws_instance" "brickcheck" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = var.instance_type
  key_name               = var.key_name
  vpc_security_group_ids = [aws_security_group.brickcheck.id]
  iam_instance_profile   = aws_iam_instance_profile.brickcheck.name

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region                 = var.region
    repo_url               = var.repo_url
    api_key_parameter      = var.api_key_parameter
    app_password_parameter = var.app_password_parameter
  })

  root_block_device {
    volume_size = 12
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    # IMDSv2 only — a token is required, which blocks the SSRF-style reads of
    # instance credentials that IMDSv1 allows.
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = { Name = "brickcheck" }
}
