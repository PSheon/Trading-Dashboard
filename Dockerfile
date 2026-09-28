FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev

# DATA_DIR is where the persistent volume is mounted. Everything the app keeps
# lives there: raw responses, the Parquet warehouse and the notes database.
ENV PATH="/app/.venv/bin:$PATH" DATA_DIR=/data SCHEDULE_UTC=00:15
EXPOSE 8000
CMD ["sh", "-c", "sw serve --host 0.0.0.0 --port ${PORT:-8000}"]
