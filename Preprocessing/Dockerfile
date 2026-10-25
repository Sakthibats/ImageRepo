# The processing service, for amd64 and arm64 alike: libvips and libheif come
# inside the pyvips-binary and pillow-heif wheels, which exist for both;
# ffmpeg, for video, is the one system package.
FROM python:3.12-slim-trixie AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# The dependencies in a layer of their own, so a code change does not
# download and install them again.
COPY pyproject.toml ./
RUN mkdir preprocessing && touch preprocessing/__init__.py && pip install . && rm -r preprocessing
COPY preprocessing ./preprocessing
RUN pip install --no-deps --force-reinstall .

# `docker build --target test .` runs the test suite in the image: the proof
# that ffmpeg, libvips and libheif all work in here, with no credentials.
FROM base AS test
RUN pip install pytest
COPY tests ./tests
RUN python -m pytest -q -p no:cacheprovider

FROM base
RUN useradd --system --no-create-home worker
USER worker
ENTRYPOINT ["python", "-m", "preprocessing"]
CMD ["run"]
