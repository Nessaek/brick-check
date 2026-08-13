# Lets GitHub Actions deploy without any long-lived AWS credentials stored in
# the repo. Actions presents a short-lived OIDC token, AWS exchanges it for
# temporary credentials, and the trust policy pins that exchange to this one
# repository and branch.
#
# The alternative — an access key pair in GitHub secrets — is a permanent
# credential sitting in a third party, which is exactly what this project has
# spent its time avoiding.

variable "enable_github_deploy" {
  description = "Create the OIDC role that lets GitHub Actions redeploy. Set false to skip the CI/CD wiring entirely."
  type        = bool
  default     = true
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if the account already has one — AWS allows only a single provider per URL, and a second create fails with EntityAlreadyExists."
  type        = bool
  default     = true
}

variable "github_repo" {
  description = "owner/name of the repository allowed to deploy."
  type        = string
  default     = "Nessaek/brick-check"
}

variable "github_deploy_ref" {
  description = "Git ref allowed to deploy. Scoped to one branch so a fork or an unmerged branch cannot trigger a deploy."
  type        = string
  default     = "refs/heads/main"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_deploy && var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.enable_github_deploy && !var.create_oidc_provider ? 1 : 0
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.enable_github_deploy ? (
    var.create_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : data.aws_iam_openid_connect_provider.github[0].arn
  ) : null
}

resource "aws_iam_role" "github_deploy" {
  count       = var.enable_github_deploy ? 1 : 0
  name_prefix = "brickcheck-deploy-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.github_oidc_arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Pinning the exact ref matters: `repo:owner/name:*` would let any
          # branch, tag or pull request from the repo assume this role.
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:${var.github_deploy_ref}"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count       = var.enable_github_deploy ? 1 : 0
  name_prefix = "brickcheck-deploy-"
  role        = aws_iam_role.github_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Redeploy by asking SSM to run the update script on the instance.
        # No inbound SSH, and no deploy key held by GitHub.
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
          "arn:aws:ec2:${var.region}:*:instance/${aws_instance.brickcheck.id}",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = "*"
      },
    ]
  })
}

# The instance needs the SSM agent policy to receive commands at all.
resource "aws_iam_role_policy_attachment" "ssm_managed" {
  role       = aws_iam_role.brickcheck.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE secret in the GitHub repository."
  value       = var.enable_github_deploy ? aws_iam_role.github_deploy[0].arn : null
}

output "instance_id" {
  description = "Set this as the AWS_INSTANCE_ID secret in the GitHub repository."
  value       = aws_instance.brickcheck.id
}
