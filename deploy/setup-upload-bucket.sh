#!/usr/bin/env bash
# Idempotent provisioning for the Seoul upload/staging bucket.
# Browser/AENA uploads land here first; media.prepare promotes them to GCS_BUCKET.
set -euo pipefail

PROJECT="${PROJECT:-step-d}"
UPLOAD_BUCKET="${GCS_UPLOAD_BUCKET:-stepd-upload-seoul}"
LOCATION="${GCS_UPLOAD_LOCATION:-asia-northeast3}"
RUNTIME_SA="${RUNTIME_SA:-stepd-deployer@${PROJECT}.iam.gserviceaccount.com}"
export CLOUDSDK_CORE_ACCOUNT="${CLOUDSDK_CORE_ACCOUNT:-$RUNTIME_SA}"

if gcloud storage buckets describe "gs://${UPLOAD_BUCKET}" --project="$PROJECT" >/dev/null 2>&1; then
  actual_location="$(gcloud storage buckets describe "gs://${UPLOAD_BUCKET}" \
    --project="$PROJECT" --format='value(location)')"
  if [ "${actual_location^^}" != "${LOCATION^^}" ]; then
    echo "[upload-bucket] location mismatch: ${actual_location} (expected ${LOCATION})" >&2
    exit 1
  fi
else
  gcloud storage buckets create "gs://${UPLOAD_BUCKET}" \
    --project="$PROJECT" \
    --location="$LOCATION" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access \
    --public-access-prevention \
    --soft-delete-duration=0
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/cors.json" <<'JSON'
[
  {
    "origin": ["https://stepd.stepai.kr", "http://localhost:3000"],
    "method": ["PUT", "POST", "GET", "HEAD", "OPTIONS"],
    "responseHeader": ["Content-Type", "Content-Range", "Range", "x-goog-resumable", "ETag"],
    "maxAgeSeconds": 3600
  }
]
JSON

# Successfully promoted objects are deleted immediately. This lifecycle rule only catches
# abandoned uploads whose client never called finalize; seven days leaves room for recovery.
cat >"$tmp_dir/lifecycle.json" <<'JSON'
{
  "rule": [
    { "action": { "type": "Delete" }, "condition": { "age": 7 } }
  ]
}
JSON

gcloud storage buckets update "gs://${UPLOAD_BUCKET}" \
  --project="$PROJECT" \
  --uniform-bucket-level-access \
  --public-access-prevention \
  --soft-delete-duration=0 \
  --cors-file="$tmp_dir/cors.json" \
  --lifecycle-file="$tmp_dir/lifecycle.json"

gcloud storage buckets add-iam-policy-binding "gs://${UPLOAD_BUCKET}" \
  --project="$PROJECT" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role="roles/storage.objectAdmin" >/dev/null

gcloud storage buckets describe "gs://${UPLOAD_BUCKET}" --project="$PROJECT" \
  --format='yaml(name,location,default_storage_class,uniform_bucket_level_access,public_access_prevention,soft_delete_policy,cors_config,lifecycle_config)'
