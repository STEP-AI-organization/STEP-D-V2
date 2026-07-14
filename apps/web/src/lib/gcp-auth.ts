import { GoogleAuth } from "google-auth-library";

let authClient: ReturnType<typeof createIdTokenClient> | null = null;

function createIdTokenClient() {
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const targetAudience = process.env.CLOUD_RUN_URL || "";
  if (!keyJson) throw new Error("GCP_SERVICE_ACCOUNT_KEY not set");
  const credentials = JSON.parse(keyJson);
  const auth = new GoogleAuth({ credentials });
  return auth.getIdTokenClient(targetAudience);
}

export async function getIdToken(): Promise<string> {
  if (!authClient) {
    authClient = createIdTokenClient();
  }
  const client = await authClient;
  // getRequestHeaders() returns a fetch Headers, not a plain object — indexing it
  // yields undefined, which would send an empty Authorization and get us a 403.
  const headers = await client.getRequestHeaders();
  const authorization = headers.get("authorization");
  if (!authorization) {
    throw new Error("google-auth-library returned no Authorization header — check CLOUD_RUN_URL (ID token audience) and the service account key");
  }
  return authorization;
}
