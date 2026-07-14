# ──────────────────────────────────────────────────────────────────────
# STEP-D Server — Cloud Run / Cloud SQL deployment
# Usage:
#   1. Build + push:
#      gcloud builds submit apps/server --tag gcr.io/$(gcloud config get project)/stepd-server
#
#   2. Deploy to Cloud Run:
#      gcloud run deploy stepd-server \
#        --image gcr.io/$(gcloud config get project)/stepd-server \
#        --platform managed \
#        --region asia-northeast3 \
#        --allow-unauthenticated \
#        --cpu 2 \
#        --memory 4Gi \
#        --timeout 600 \
#        --concurrency 10 \
#        --min-instances 0 \
#        --max-instances 5 \
#        --set-env-vars="NODE_ENV=production,PORT=4000" \
#        --set-secrets="DATABASE_URL=stepd-db-url:latest" \
#        --set-secrets="GOOGLE_CLIENT_ID=stepd-google-client-id:latest" \
#        --set-secrets="GOOGLE_CLIENT_SECRET=stepd-google-client-secret:latest" \
#        --set-secrets="JWT_SECRET=stepd-jwt-secret:latest" \
#        --set-secrets="PUBLIC_URL=stepd-public-url:latest" \
#        --set-env-vars="GCS_BUCKET=stepd-uploads" \
#        --add-cloudsql-instances $(gcloud config get project):asia-northeast3:stepd-db
#
#  Prerequisites:
#   - GCP project with Cloud Run, Cloud SQL, Secret Manager, Cloud Storage APIs enabled
#   - Cloud SQL PostgreSQL instance named "stepd-db" in asia-northeast3
#   - Database "stepd" created:
#       gcloud sql databases create stepd --instance=stepd-db
#   - Schema applied:
#       gcloud sql connect stepd-db --user=postgres --database=stepd
#         (then run: \i apps/server/schema.sql)
#   - GCS bucket created:
#       gsutil mb -l asia-northeast3 gs://stepd-uploads
#   - Secrets in Secret Manager:
#       gcloud secrets create stepd-db-url --replication-policy=automatic
#       echo -n "postgresql://stepd-user:password@//cloudsql/project:region:stepd-db/stepd" | \
#         gcloud secrets versions add stepd-db-url --data-file=-
#     (replace with actual Cloud SQL socket connection string)
#   - Service account for Cloud Run with:
#       roles/cloudsql.client (Cloud SQL access)
#       roles/storage.objectAdmin (GCS bucket writes)
#       roles/secretmanager.secretAccessor (Secret Manager access)
# =========================================================
echo "Deploying STEP-D server to Cloud Run..."

PROJECT_ID=$(gcloud config get project)
REGION=asia-northeast3
IMAGE="gcr.io/${PROJECT_ID}/stepd-server"
SERVICE_NAME="stepd-server"

echo "=== Building container image ==="
gcloud builds submit apps/server --tag "${IMAGE}"

echo "=== Deploying to Cloud Run ==="
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --cpu 2 \
  --memory 4Gi \
  --timeout 600 \
  --concurrency 10 \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars="NODE_ENV=production,PORT=4000" \
  --set-secrets="DATABASE_URL=stepd-db-url:latest" \
  --set-secrets="GOOGLE_CLIENT_ID=stepd-google-client-id:latest" \
  --set-secrets="GOOGLE_CLIENT_SECRET=stepd-google-client-secret:latest" \
  --set-secrets="JWT_SECRET=stepd-jwt-secret:latest" \
  --set-secrets="PUBLIC_URL=stepd-public-url:latest" \
  --set-env-vars="GCS_BUCKET=stepd-uploads" \
  --add-cloudsql-instances "${PROJECT_ID}:${REGION}:stepd-db"

echo "=== Done ==="
echo "Get the service URL with:"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format='value(status.url)'"