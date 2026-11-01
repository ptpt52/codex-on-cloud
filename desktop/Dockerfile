# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS node

FROM kasmweb/core-ubuntu-noble:1.19.0@sha256:69730b0ee6a572635fad9f8cf3ecb3d40fb86e01000f964b2dab719c664f67f4
USER root
ENV DEBIAN_FRONTEND=noninteractive
COPY --from=node /usr/local/ /usr/local/
ARG CODEX_VERSION=0.166.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux xterm xclip xdotool python3 python3-venv python3-pip \
      build-essential curl ca-certificates fonts-noto-cjk fonts-dejavu-core \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && codex --version \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /root/.npm
COPY desktop/agent.py /opt/codex-cloud/agent.py
COPY desktop/entrypoint.sh /opt/codex-cloud/entrypoint.sh
COPY desktop/custom_startup.sh /dockerstartup/custom_startup.sh
COPY desktop/codex-workbench desktop/codex-session desktop/open-codex-terminal /usr/local/bin/
RUN chmod 755 /opt/codex-cloud/entrypoint.sh /dockerstartup/custom_startup.sh /usr/local/bin/codex-workbench /usr/local/bin/codex-session /usr/local/bin/open-codex-terminal \
    && mkdir -p /workspace/transfer \
    && chown -R 1000:1000 /workspace
ENV HOME=/home/kasm-user \
    CODEX_HOME=/home/kasm-user/.codex \
    DISPLAY=:1 \
    VNC_RESOLUTION=1280x800 \
    MAX_FRAME_RATE=20 \
    VNCOPTIONS="-NeverShared -DLP_ClipTypes text/html" \
    AGENT_SECRET_FILE=/run/secrets/agent_secret
USER 1000
WORKDIR /workspace
EXPOSE 6901 6902
ENTRYPOINT ["/opt/codex-cloud/entrypoint.sh"]
CMD ["--wait"]
