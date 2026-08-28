FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends nginx curl && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/loot-radar

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/
COPY nginx.conf /etc/nginx/sites-available/default
# Debian's stock nginx.conf events block (worker_connections 768) is far
# below what "thousands of simultaneous users, each holding a live SSE
# connection" needs -- see entrypoint.sh's own ulimit raise for the
# matching fix on the process-FD-limit side of this same ceiling. That
# top-level nginx.conf isn't something this repo supplies (only the
# server{} block in nginx.conf above is ours), so it's patched in place at
# build time instead of maintaining a full parallel copy of Debian's own
# config just to change one number.
RUN sed -i 's/worker_connections 768;/worker_connections 8192;/' /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=8080
EXPOSE 8080

CMD ["/entrypoint.sh"]
