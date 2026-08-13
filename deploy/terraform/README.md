# Terraform / OpenTofu deployment

Builds the whole AWS side: security group, IAM role, and a Graviton EC2
instance that clones this repo, builds the image and runs it under systemd on
first boot.

Works with either `terraform` or `tofu` — the configuration is plain HCL with
no provider-specific extensions.

## The one design decision worth knowing

**The API key is not a Terraform variable.** Every value Terraform touches is
written to state in plaintext, so a key passed in as a variable ends up in
`terraform.tfstate` — and in whatever S3 bucket, CI artefact or repository
that state later lives in. Marking a variable `sensitive` only hides it from
console output; it is still in state.

So the secrets go into SSM Parameter Store out-of-band, and Terraform only
ever learns their *names*. The instance reads the values at boot using its IAM
role. Nothing secret passes through Terraform, user-data, or the AMI.

## 1. Store the secrets

Once, with the AWS CLI. These never appear in any file you commit:

```bash
aws ssm put-parameter --name /brickcheck/anthropic_api_key --type SecureString --value 'sk-ant-...'
```

```bash
aws ssm put-parameter --name /brickcheck/app_password --type SecureString --value 'choose-a-strong-one'
```

Rotating a key later is a `put-parameter --overwrite` plus an instance reboot;
no Terraform run is needed.

## 2. Configure

```bash
cp terraform.tfvars.example terraform.tfvars
```

Fill in `admin_cidr` (your own address as `x.x.x.x/32` — `curl
https://checkip.amazonaws.com` prints it) and `key_name` (an existing EC2 key
pair). `terraform.tfvars` is git-ignored.

## 3. Apply

```bash
tofu init && tofu apply
```

Outputs give the URL and an SSH command. **The instance is not ready when
apply finishes** — cloud-init still has to install Docker and build the image,
which takes several minutes. Watch it:

```bash
ssh ec2-user@<public-ip> 'sudo tail -f /var/log/brickcheck-setup.log'
```

## 4. Check the two lines that matter

```bash
ssh ec2-user@<public-ip> 'docker logs brickcheck'
```

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
Password protection enabled (APP_PASSWORD).
```

`Image processing DISABLED` means the Python layer did not build, and the app
will answer at clearly worse accuracy while looking healthy. The setup script
tails these into `/var/log/brickcheck-setup.log` too, so a failure is visible
without going hunting.

## What this does and does not do

Included: default-VPC security group (SSH from your address only, HTTP from
anywhere), an IAM role scoped to exactly the two SSM parameters, an encrypted
gp3 root volume, IMDSv2 required, and `user_data_replace_on_change` so editing
the setup script rebuilds the instance rather than silently doing nothing.

Not included:

- **A static address.** Stop/start gives the instance a new public IP. Add an
  `aws_eip` if that matters.
- **A spend cap.** The app does not meter spend. Set a limit on the Anthropic
  account — that is the only control.
- **State backend.** State is local by default. If you move it to S3, remember
  it contains no secrets by design, but still holds your infrastructure layout.

## HTTPS

Caddy runs in front of the app and gets a Let's Encrypt certificate
automatically. The app container publishes no host port at all — it is
reachable only over a private Docker network from Caddy, so nobody can hit it
directly on :3000 and forge `X-Forwarded-For` to get past the rate limit.

Let's Encrypt needs a hostname, not an IP. With no domain set, the instance
serves as `<public-ip>.sslip.io` — sslip.io resolves that straight back to the
IP, and it is a real hostname, so the certificate is genuine and publicly
trusted. No domain purchase, no DNS to configure.

If you do own a domain, point an A record at the instance and set:

```hcl
domain = "brickcheck.example.com"
```

Two consequences of the sslip.io default worth knowing: stopping and starting
the instance changes its public IP, which changes the hostname and means a new
certificate (add an `aws_eip` if that matters), and sslip.io is a third party
in your name resolution. A real domain avoids both.

## CI/CD

`enable_github_deploy` (default on) creates an OIDC role that lets GitHub
Actions redeploy without any long-lived AWS credentials in the repository.
Actions presents a short-lived token, AWS swaps it for temporary credentials,
and the trust policy pins that exchange to this repo and the `main` branch —
`repo:owner/name:*` would let any branch or pull request assume it.

After `apply`, wire the two outputs into the repository:

```bash
gh secret set AWS_DEPLOY_ROLE --body "$(tofu output -raw github_deploy_role_arn)"
```

```bash
gh secret set AWS_INSTANCE_ID --body "$(tofu output -raw instance_id)"
```

Deploys then run on pushes to `main` that touch the app, via SSM Run Command —
no inbound SSH, and no deploy key held by GitHub. The workflow fails if the
instance comes back with image processing disabled, so a deploy that silently
drops the Python layer is caught rather than shipped.

If `apply` fails with `EntityAlreadyExists` on the OIDC provider, the account
already has one (they are unique per URL). Set `create_oidc_provider = false`
and re-apply.

## Verification status

`tofu validate` passes and the configuration is `tofu fmt` clean. It has **not**
been applied against a live AWS account, so treat the first `apply` as the real
test — provider-level rejections (an unavailable instance type in your region,
a missing key pair) only surface then.
