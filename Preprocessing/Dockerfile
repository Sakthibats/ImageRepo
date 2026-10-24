FROM python:3.12-slim-bookworm

# libvips and libheif come inside the pyvips-binary and pillow-heif wheels;
# ffmpeg, for video, is the one system package.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY pyproject.toml ./
COPY preprocessing ./preprocessing
RUN pip install --no-cache-dir . && useradd --system --no-create-home worker

USER worker
ENTRYPOINT ["python", "-m", "preprocessing"]
CMD ["run"]
