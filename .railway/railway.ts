import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "medusajs-backend";
export default defineRailway(() => {
  // No source: deploys come from `railway up` (see .github/workflows/deploy-backend.yml), which
  // uploads medusajs-backend without needing a Root Directory on the service.
  const medusajsBackend = service("medusajs-backend", {
    build: { builder: "NIXPACKS", nixpacksPlan: { providers: ["...", "node"] } },
    start: "yarn run migrate && yarn run start",
    healthcheck: "/health",
    replicas: { "us-west2": 1 },
    deploy: { restartPolicyMaxRetries: 11 },
  });

  return project("CardLister", {
    variables: { managed: false },
    resources: [medusajsBackend],
  });
});
