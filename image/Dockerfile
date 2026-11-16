# Job-Image: Jeder Factory-Job läuft in einem eigenen Container aus diesem Image.
# Enthält OpenCode (Standard) oder Claude Code (optional, WITH_CLAUDE=1), GitHub CLI,
# git, Node und einen Chromium für Screenshots/E2E-Tests.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
ARG WITH_CLAUDE=0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git jq curl ca-certificates gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update -qq && apt-get install -y -qq gh \
 && rm -rf /var/lib/apt/lists/*

# Playwright als globales Paket (Browser sind im Basis-Image schon vorhanden)
RUN npm install -g playwright@1.65.0 && npm cache clean --force
ENV NODE_PATH=/usr/lib/node_modules

# Factory-Werkzeuge, Playbook und Workflow
COPY image/bin/ /usr/local/bin/
COPY image/entrypoint.sh /factory/entrypoint.sh
COPY image/preview.sh /factory/preview.sh
COPY image/improve.sh /factory/improve.sh
COPY playbooks/factory.md /factory/playbook.md
COPY playbooks/improve.md /factory/improve.md
COPY workflows/ /factory/workflows/
RUN chmod +x /usr/local/bin/factory-* /factory/entrypoint.sh /factory/preview.sh /factory/improve.sh

# Agent als normaler Nutzer installieren (offizielle Installer)
USER pwuser
ENV HOME=/home/pwuser

# OpenCode 2 (MIT) – Standard-Agent. Modelle kommen über OpenRouter o. ä., siehe docs/opencode-openrouter.md
# Wichtig: /v2/install — der Pfad /install liefert Version 1, die unsere permissions-Form nicht kennt.
RUN curl -fsSL https://opencode.ai/v2/install | bash \
 && ( ~/.opencode/bin/opencode --version || ~/.opencode/bin/opencode2 --version ) | sed 's/^/[opencode] /'
COPY --chown=pwuser:root image/opencode.json /home/pwuser/.config/opencode/opencode.json

# Claude Code nur, wenn ausdrücklich verlangt (Rückfallweg)
RUN if [ "$WITH_CLAUDE" = "1" ]; then curl -fsSL https://claude.ai/install.sh | bash; fi
ENV PATH=/home/pwuser/.opencode/bin:$PATH
# Python-Projekte: uv (verwaltet Python-Versionen und Pakete selbst)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=/home/pwuser/.local/bin:$PATH

WORKDIR /work
ENTRYPOINT ["/factory/entrypoint.sh"]
