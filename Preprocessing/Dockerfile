FROM python:3.12-slim-bookworm

# libvips and libheif come inside the pyvips-binary and pillow-heif wheels, so
# the image needs no system image libraries. (ffmpeg arrives with video.)
WORKDIR /app
COPY pyproject.toml ./
COPY preprocessing ./preprocessing
RUN pip install --no-cache-dir . && useradd --system --no-create-home worker

USER worker
ENTRYPOINT ["python", "-m", "preprocessing"]
CMD ["run"]
