# BrickCheck runs Node for the server and Python/OpenCV for image processing.
# The Python stack is NOT optional in practice: photo alignment, the
# coordinate grid that makes issue pins accurate, and the zoomed second-pass
# verification that filters false positives are all gated on it. Without it
# the app still starts and still answers, just noticeably worse — so the
# image bakes it in and the startup log says which mode you are in.
FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so edits to the app code don't rebuild this layer.
COPY preprocess/requirements.txt preprocess/requirements.txt
RUN python3 -m venv preprocess/.venv \
 && preprocess/.venv/bin/pip install --no-cache-dir --upgrade pip \
 && preprocess/.venv/bin/pip install --no-cache-dir -r preprocess/requirements.txt \
 && preprocess/.venv/bin/python3 -c "import cv2, numpy, skimage; print('opencv', cv2.__version__)"

# The server has no npm dependencies, so there is nothing to install here.
COPY package.json ./
COPY server.js app.js index.html styles.css example-reference.jpg ./
COPY preprocess/align.py preprocess/grid.py preprocess/crop.py preprocess/

# TRUST_PROXY makes the rate limiter read X-Forwarded-For, which is correct
# behind a platform load balancer (Fly, Railway, Render) and wrong if the
# container is exposed directly — unset it in that case.
ENV PORT=3000 \
    TRUST_PROXY=1 \
    NODE_ENV=production

# Provide these at runtime, never in the image:
#   ANTHROPIC_API_KEY   required
#   APP_PASSWORD        shared password; without it the app is open to anyone
#   CLAUDE_MODEL        optional, defaults to claude-sonnet-5
#   REBRICKABLE_API_KEY optional; enables exact brick codes from an uploaded
#                       instruction page. Absent, the app names no part codes
#                       rather than guessing them.
#
# The app holds no state, so no volume is needed. Spend is capped by the
# limit set on the Anthropic account, which is authoritative and cannot be
# defeated by a bug here.

EXPOSE 3000
USER node
CMD ["node", "server.js"]
