#!/bin/sh
set -eu

mc alias set lab http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "lab/$AIRSHIP_LAB_BUCKET"

if ! mc admin user info lab "$AIRSHIP_LAB_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add lab "$AIRSHIP_LAB_ACCESS_KEY" "$AIRSHIP_LAB_SECRET_KEY"
fi

mc admin policy create lab airship-vault-probe /config/minio-policy.json
mc admin policy attach lab airship-vault-probe --user "$AIRSHIP_LAB_ACCESS_KEY"

echo "Airship local S3 bucket, CORS policy, and scoped probe identity are ready."
