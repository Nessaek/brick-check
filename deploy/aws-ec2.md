# Deploying to AWS, cheaply

The app is a single stateless container. That rules the expensive AWS options
out rather than in:

| Option | Verdict |
| --- | --- |
| **EC2 (Graviton) + Docker** | **Cheapest.** One small ARM instance, free-tier eligible on new accounts. What this guide uses. |
| Lightsail | Similar price, simpler console, slightly less control. Fine alternative. |
| App Runner | Managed and pleasant, but you pay for provisioned memory continuously — for an app used a few times a week that is poor value. |
| ECS/Fargate + ALB | The load balancer alone costs more per month than everything else here combined. Avoid for one container. |
| Lambda | The 1GB image and the OpenCV layer make cold starts slow, for no benefit at this traffic. |

Graviton matters for two reasons: the instances are cheaper than x86, and they
are `arm64` — the same architecture as an Apple Silicon Mac, so the image
builds natively instead of under emulation.

---

## 1. Launch the instance

In the EC2 console, launch an instance with:

- **AMI**: Amazon Linux 2023 (**Arm** variant)
- **Type**: `t4g.small` — 2GB RAM. `t4g.micro` (1GB) works but leaves little
  headroom once OpenCV has decoded two photos.
- **Key pair**: create or reuse one, so you can SSH in
- **Security group**: allow SSH (22) from your IP only, and HTTP (80) from
  anywhere
- **Storage**: the 8GB default is enough — the image is about 1GB

## 2. Install Docker

SSH in, then:

```bash
sudo dnf update -y && sudo dnf install -y docker git
```

```bash
sudo systemctl enable --now docker && sudo usermod -aG docker ec2-user
```

Log out and back in so the group change applies.

## 3. Build the image on the instance

Building on the instance avoids pushing a 1GB image over your home connection.

```bash
git clone https://github.com/Nessaek/bricksolver.git && cd bricksolver
```

```bash
docker build -t brickcheck .
```

## 4. Run it

Put the secrets in a root-only env file rather than the command line, so they
do not sit in your shell history or in `ps` output:

```bash
sudo install -m 600 /dev/null /etc/brickcheck.env
```

```bash
sudo tee /etc/brickcheck.env >/dev/null <<'EOF'
ANTHROPIC_API_KEY=sk-ant-...
APP_PASSWORD=choose-a-strong-one
EOF
```

Then run it as a service that survives reboots, publishing on port 80:

```bash
sudo tee /etc/systemd/system/brickcheck.service >/dev/null <<'EOF'
[Unit]
Description=BrickSolver
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f brickcheck
ExecStart=/usr/bin/docker run --rm --name brickcheck \
  -p 80:3000 --env-file /etc/brickcheck.env brickcheck
ExecStop=/usr/bin/docker stop brickcheck

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now brickcheck
```

## 5. Verify — do not skip this

```bash
docker logs brickcheck
```

You need to see **both** of these:

```
Image processing enabled — photo alignment, coordinate grid and zoomed issue verification are all active.
Password protection enabled (APP_PASSWORD).
```

`Image processing DISABLED` means the Python layer did not build, and the app
will answer at markedly reduced accuracy while looking perfectly healthy.
`No APP_PASSWORD set` means anyone with the address can spend your API credit.

Then browse to `http://<public-ip>/` — you should be prompted for the password.

## Cost control

The app does **not** cap spend. Set a spend limit on your Anthropic account;
that is the only authoritative control. For scale, one measured analysis with
a reference photo cost about **$0.02**.

`TRUST_PROXY=1` is baked into the image, which is correct behind a load
balancer. In this setup the container is exposed directly, so unset it —
otherwise a client can spoof `X-Forwarded-For` and bypass the rate limit:

```bash
echo 'TRUST_PROXY=' | sudo tee -a /etc/brickcheck.env && sudo systemctl restart brickcheck
```

## HTTPS

The steps above serve plain HTTP, so the password travels in clear text. For
anything beyond a quick trial, put it behind a TLS terminator — Caddy is the
least work, needing only a domain pointed at the instance and two lines of
config. Until then, treat the password as protecting your API credit rather
than as real security.
