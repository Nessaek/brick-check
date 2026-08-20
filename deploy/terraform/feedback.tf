# Storage for submissions a user reported as wrong.
#
# The instance can PUT here and nothing else — no GetObject, no ListBucket. If
# the app is ever compromised, the attacker can add objects but cannot read
# back the photos other people reported. Pulling them down is a job for your
# own credentials, not the server's.

variable "collect_feedback" {
  description = "Create the bucket that stores submissions users report as wrong. With this off, the report button is hidden and no photos are ever stored."
  type        = bool
  default     = true
}

variable "feedback_retention_days" {
  description = "How long reported submissions are kept before S3 deletes them. These are photos of people's homes, so the default is deliberately short."
  type        = number
  default     = 90
}

resource "aws_s3_bucket" "feedback" {
  count         = var.collect_feedback ? 1 : 0
  bucket_prefix = "brickcheck-feedback-"
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "feedback" {
  count                   = var.collect_feedback ? 1 : 0
  bucket                  = aws_s3_bucket.feedback[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "feedback" {
  count  = var.collect_feedback ? 1 : 0
  bucket = aws_s3_bucket.feedback[0].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Retention is the deletion story. Without it "we keep them for 90 days" is a
# claim the UI makes and nothing enforces.
resource "aws_s3_bucket_lifecycle_configuration" "feedback" {
  count  = var.collect_feedback ? 1 : 0
  bucket = aws_s3_bucket.feedback[0].id

  rule {
    id     = "expire-reported-submissions"
    status = "Enabled"
    filter {}
    expiration { days = var.feedback_retention_days }
  }
}

resource "aws_iam_role_policy" "feedback_write" {
  count       = var.collect_feedback ? 1 : 0
  name_prefix = "brickcheck-feedback-"
  role        = aws_iam_role.brickcheck.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject"]
      Resource = "${aws_s3_bucket.feedback[0].arn}/*"
    }]
  })
}

output "feedback_bucket" {
  description = "Where reported submissions land. Pull one down with: aws s3 sync s3://<bucket>/<id>/ /tmp/<id>/"
  value       = var.collect_feedback ? aws_s3_bucket.feedback[0].bucket : null
}
