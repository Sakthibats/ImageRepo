from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from .config import Config
from .keys import CACHE_FOREVER

MiB = 1024 * 1024
TRANSFER = TransferConfig(multipart_threshold=64 * MiB, multipart_chunksize=16 * MiB, max_concurrency=4)


class R2:
    """The bucket, through R2's S3 API."""

    def __init__(self, cfg: Config):
        self.bucket = cfg.r2_bucket
        self.s3 = boto3.client(
            's3',
            endpoint_url=f'https://{cfg.r2_account_id}.r2.cloudflarestorage.com',
            aws_access_key_id=cfg.r2_access_key_id,
            aws_secret_access_key=cfg.r2_secret_access_key,
            region_name='auto',
            config=BotoConfig(
                retries={'max_attempts': 5, 'mode': 'standard'},
                # Newer boto3 adds checksum headers R2 does not take on every call.
                request_checksum_calculation='when_required',
                response_checksum_validation='when_required',
                max_pool_connections=32,
            ),
        )

    def download(self, key: str, path: Path) -> None:
        self.s3.download_file(self.bucket, key, str(path), Config=TRANSFER)

    def put(self, key: str, body: bytes, content_type: str) -> None:
        # Content-addressed keys never change, so everything is cached forever.
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body,
                           ContentType=content_type, CacheControl=CACHE_FOREVER)

    def put_file(self, key: str, path: Path, content_type: str) -> None:
        """Streams from disk, in parts above 64MB."""
        self.s3.upload_file(str(path), self.bucket, key, Config=TRANSFER,
                            ExtraArgs={'ContentType': content_type, 'CacheControl': CACHE_FOREVER})

    def check(self) -> str:
        """Proves the keys can list the bucket; used by `doctor`."""
        try:
            r = self.s3.list_objects_v2(Bucket=self.bucket, Prefix='inbox/', MaxKeys=1000)
            return f'ok, {r.get("KeyCount", 0)} file(s) waiting in inbox/'
        except ClientError as e:
            return f'failed: {e.response.get("Error", {}).get("Code", "error")}'
