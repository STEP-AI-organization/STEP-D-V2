# ──────────────────────────────────────────────────────────────────────
# STEP-D Server — Cloud Run / Cloud SQL deployment
# Usage:
#   1. Build + push:
#      gcloud builds submit apps/server --tag us-central1-docker.pkg.dev/$(gcloud config get project)/stepd-server/stepd-server
#
#   2. Deploy to Cloud Run:
#      gcloud run deploy stepd-server \
#        --image us-central1-docker.pkg.dev/$(gcloud config get project)/stepd-server/stepd-server \
#        --platform managed \
#        --region us-central1 \
#        --allow-unauthenticated \
#        --cpu 2 \
#        --memory 4Gi \
#        --timeout 600 \
#        --concurrency 10 \
#        --min-instances 0 \
#        --max-instances 5 \
#        --set-env-vars="NODE_ENV=production,PORT=4000,GCS_BUCKET=stepd-media" \
#        --set-secrets="DATABASE_URL=stepd-db-url:latest" \
#        --set-secrets="GOOGLE_CLIENT_ID=stepd-google-client-id:latest" \
#        --set-secrets="GOOGLE_CLIENT_SECRET=stepd-google-client-secret:latest" \
#        --set-secrets="JWT_SECRET=stepd-jwt-secret:latest" \
#        --set-secrets="PUBLIC_URL=stepd-public-url:latest" \
#        --add-cloudsql-instances step-d:us-central1:stepd-db \
#        --service-account stepd-deployer@step-d.iam.gserviceaccount.com
# =========================================================
echo "Deploying STEP-D server to Cloud Run..."

PROJECT_ID=$(gcloud config get project)
REGION=us-central1
IMAGE="us-central1-docker.pkg.dev/${PROJECT_ID}/stepd-server/stepd-server"
SERVICE_NAME="stepd-server"
SA="stepd-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

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
  --set-env-vars="NODE_ENV=production,PORT=4000,GCS_BUCKET=stepd-media" \
  --set-secrets="DATABASE_URL=stepd-db-url:latest" \
  --set-secrets="GOOGLE_CLIENT_ID=stepd-google-client-id:latest" \
  --set-secrets="GOOGLE_CLIENT_SECRET=stepd-google-client-secret:latest" \
  --set-secrets="JWT_SECRET=stepd-jwt-secret:latest" \
  --set-secrets="PUBLIC_URL=stepd-public-url:latest" \
  --add-cloudsql-instances "${PROJECT_ID}:${REGION}:stepd-db" \
  --service-account "${SA}"

echo "=== Done ==="
echo "Get the service URL with:"
echo "  gcloud run services describe ${SERVICE_NAME} --region ${REGION} --format='value(status.url)'"