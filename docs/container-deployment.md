# Portable container deployment

For the complete production setup, use the [README container runbook](../README.md#deploy-containers-to-aws-azure-or-gcp). It includes `konda.com` DNS/HTTPS, first-time AWS Fargate/Azure/GCP provisioning, GitHub OIDC identities, environment variables, the manual `deploy-container.yml` workflow, verification, and rollback. The examples below remain lower-level runtime/manual deployment references, not the GitHub workflow setup.

The same OCI image runs on Azure Container Apps, Google Cloud Run, AWS ECS/Fargate, or another Linux container host. There are **no cloud SDKs, embedded credentials, Node.js, SSR, databases, or form handlers in the runtime**. A Node 24 build stage validates the configuration, runs type/unit checks, and produces the static site. The final stage contains Nginx and the generated HTML/CSS/assets and security policy.

Container hosting uses managed compute and is **not literally zero-compute hosting**. The original [S3 + CloudFront](aws-deployment.md), Cloudflare Pages, and Netlify static deployment options remain available when a running web-server process is undesirable.

## Run locally

Install Docker with Compose and start the site from the repository root; a local Node installation is not required:

```sh
docker compose up --build
```

Open `http://127.0.0.1:8080`. Stop with Ctrl+C, then run `docker compose down`. Compose binds only to loopback, uses a read-only root filesystem, drops all Linux capabilities, disallows privilege escalation, and gives Nginx a small writable `/tmp`.

Without Compose:

```sh
docker build --tag konda-services:local .
docker run --rm --name konda-site \
  --publish 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  konda-services:local
```

For a different internal port, pass `--env PORT=9090 --publish 127.0.0.1:9090:9090` instead. `EXPOSE 8080` is metadata, not a port restriction.

## Runtime contract

| Setting | Contract |
| --- | --- |
| Image platform | Build `linux/amd64` for the cloud examples below; `linux/arm64` is also supported for compatible hosts |
| Listener | HTTP on `0.0.0.0:$PORT`, default `8080`; numeric ports `1024`–`65535` only |
| Health | `GET /healthz` returns `200` and `ok`; configure the cloud's own health probe, not just Docker's `HEALTHCHECK` |
| User | Non-root UID/GID `101:101`; static files remain root-owned and read-only to this user |
| Writes | Only `/tmp` for generated Nginx configuration, PID, and temporary files; no persistent volume is needed |
| Logging | Access logs to stdout, errors to stderr; successful health probes are not access-logged |
| TLS | Terminate HTTPS at the provider's ingress/load balancer and redirect public HTTP there; the container itself serves HTTP |
| Content | `site.config.json` is consumed **at build time**, not exposed publicly or read from runtime environment variables |
| Contact | An optional native form posts directly to the configured external HTTPS provider; this container rejects non-GET/HEAD requests |

Security headers, including strict CSP, come from `src/lib/security.mjs` and are generated into `.deploy/nginx-security-headers.conf`. Nginx applies them to successful and error responses. Missing files return the branded **404**, not a successful homepage fallback. Dotfiles and `_headers` are not served. Successful hashed `/_astro/` assets are immutable-cacheable; HTML, unhashed assets, and errors require revalidation.

Use `127.0.0.1` for local HTTP testing. Production requires HTTPS for the CSP upgrade directive and HSTS to work as intended. Do not add a conflicting CSP at a reverse proxy: multiple CSP headers are enforced together, not merged permissively.

## Prepare a production image

1. Edit `site.config.json`: the default organization is **Konda Engineering and security services**, with Security Architecture, Pentesting, DevSecOps, GRC, and Platform Engineering. All branding, services, theme, routing, and enquiry settings remain in that file.
2. Verify ownership/DNS for the configured `https://konda.com` domain and the published address, phone, and WhatsApp account. Production requires a phone, WhatsApp link, email, or HTTPS form endpoint. Review privacy text and indexing before public release. No credentials belong in this public content file.
3. Use `--build-arg VALIDATE_PRODUCTION=true` for every public release. It fails closed on placeholder domains/contact details. The default `false` allows local/CI builds while editing incomplete configurations. An invalid flag value also fails the build.
4. Authenticate to your selected registry using your normal SSO/workload identity. Use an immutable release tag or digest, not a mutable `latest` deployment.

```sh
docker buildx build --platform linux/amd64 --load \
  --build-arg VALIDATE_PRODUCTION=true \
  --tag konda-services:release .
```

The cloud examples below build and push this same image after setting a registry-specific `IMAGE`. On Apple Silicon, explicitly selecting `linux/amd64` avoids accidentally publishing an ARM-only image to an AMD64 service. The build stage always runs on the builder's native architecture because its output is architecture-independent static files.

For a registry supporting multi-platform manifests, use `--platform linux/amd64,linux/arm64 --push` with a multi-platform-capable Buildx builder. Promote the tested image digest between environments; do not rebuild it differently per cloud. Any content, theme, canonical domain, or form-policy change requires a new build. For simultaneous sites on different canonical domains, build a release for each configured domain.

The following are **operator-run examples, not automatic provisioning by this repository**. They create billable resources and require authenticated cloud CLIs, appropriate region availability, and deployment permissions. Replace example identifiers first. Run resource-creation commands once; reuse the resources and publish a new release tag for updates. No live cloud deployment was performed as part of containerization. The identifiers match the README runbook so that a service created here can later be released through `deploy-container.yml`; that workflow also expects the GitHub OIDC identities, environment variables, and `konda.com` DNS/HTTPS steps that only the README covers.

## Azure: Container Apps + ACR

Use an authenticated Azure CLI with the `containerapp` extension. The deployer needs permission to create the resources and assign the identity's pull role, plus registry push permission. The example uses a user-assigned managed identity rather than enabling ACR admin credentials.

```sh
RG=konda-site
LOCATION=westeurope
ACR=replacewithuniqueacrname
RELEASE=release-001

az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait
az group create --name "$RG" --location "$LOCATION"
az acr create --name "$ACR" --resource-group "$RG" --sku Basic --admin-enabled false
az acr config authentication-as-arm update --registry "$ACR" --status enabled
REGISTRY=$(az acr show --name "$ACR" --query loginServer --output tsv)
REGISTRY_ID=$(az acr show --name "$ACR" --query id --output tsv)
az acr login --name "$ACR"
IMAGE="$REGISTRY/konda-services:$RELEASE"
docker buildx build --platform linux/amd64 --provenance=false --build-arg VALIDATE_PRODUCTION=true --tag "$IMAGE" --push .

az identity create --name konda-image-pull --resource-group "$RG"
IDENTITY_ID=$(az identity show --name konda-image-pull --resource-group "$RG" --query id --output tsv)
PRINCIPAL_ID=$(az identity show --name konda-image-pull --resource-group "$RG" --query principalId --output tsv)
az role assignment create --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal --role AcrPull --scope "$REGISTRY_ID"

az containerapp env create --name konda-environment --resource-group "$RG" --location "$LOCATION"
az containerapp create --name konda-site --resource-group "$RG" \
  --environment konda-environment --image "$IMAGE" --revisions-mode single \
  --registry-server "$REGISTRY" --registry-identity "$IDENTITY_ID" \
  --user-assigned "$IDENTITY_ID" --ingress external --target-port 8080 --transport auto \
  --env-vars PORT=8080 --cpu 0.25 --memory 0.5Gi --min-replicas 0 --max-replicas 3
az containerapp show --name konda-site --resource-group "$RG" \
  --query properties.configuration.ingress.fqdn --output tsv
```

Allow time for the pull-role assignment to propagate. This recipe assumes registry-level RBAC; an existing ACR using repository ABAC requires its appropriate repository-reader role instead of `AcrPull`. Leave ingress `allowInsecure` disabled, keep **Single** revision mode (the workflow refuses multiple-revision apps), and verify the HTTPS endpoint. Attach HTTP startup/readiness/liveness probes targeting `/healthz` on port `8080` using the Container Apps health-probe settings; the platform's default TCP probe only verifies an open port. Manual releases use `az containerapp update --name konda-site --resource-group "$RG" --image "$IMAGE"` after pushing a new tag; the workflow performs the same update by digest and waits for the new revision to become the ready one.

References: [container contract](https://learn.microsoft.com/en-us/azure/container-apps/containers), [managed-identity image pulls](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull), [health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes).

## GCP: Cloud Run + Artifact Registry

Use an authenticated `gcloud` CLI with permission to enable APIs, create/push to the repository, deploy Cloud Run, and act as the runtime service account. The dedicated runtime identity below needs **no application IAM roles**. Cloud Run's service agent needs registry access, especially if you later move the image to another project.

```sh
PROJECT_ID=replace-with-project-id
REGION=europe-west4
RELEASE=release-001

gcloud services enable run.googleapis.com artifactregistry.googleapis.com --project "$PROJECT_ID"
gcloud artifacts repositories create konda-sites --repository-format docker \
  --location "$REGION" --project "$PROJECT_ID"
gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/konda-sites/konda-services:$RELEASE"
docker buildx build --platform linux/amd64 --provenance=false --build-arg VALIDATE_PRODUCTION=true --tag "$IMAGE" --push .

gcloud iam service-accounts create konda-site-runtime --project "$PROJECT_ID" \
  --display-name "Konda static website"
gcloud run deploy konda-site --project "$PROJECT_ID" --region "$REGION" \
  --image "$IMAGE" --port 8080 --allow-unauthenticated --ingress all \
  --service-account "konda-site-runtime@$PROJECT_ID.iam.gserviceaccount.com" \
  --cpu 1 --memory 512Mi --min-instances 0 --max-instances 3 \
  --startup-probe 'httpGet.path=/healthz,httpGet.port=8080,periodSeconds=3,timeoutSeconds=2,failureThreshold=20' \
  --liveness-probe 'httpGet.path=/healthz,httpGet.port=8080,periodSeconds=30,timeoutSeconds=2,failureThreshold=3' \
  --quiet
```

Cloud Run supplies `PORT` itself; do not override that reserved environment variable. It terminates TLS and provides an HTTPS service URL. `--allow-unauthenticated` deliberately makes the website public; organizational policy may require an administrator to approve this. Its writable filesystem is ephemeral and memory-backed; this image writes only its small runtime files to `/tmp`. Manual releases deploy the next image with the same `gcloud run deploy` settings and a new `IMAGE`; the workflow instead updates only the image of the existing service, waits for the new revision to become ready, and then moves 100% of traffic to it. Once the service sits behind the README's HTTPS load balancer with restricted ingress, `CONTAINER_PUBLIC_URL` must be the load-balancer domain, not the `run.app` address.

References: [container runtime contract](https://cloud.google.com/run/docs/container-contract), [deploying container images](https://cloud.google.com/run/docs/deploying), [health checks](https://cloud.google.com/run/docs/configuring/healthchecks).

## AWS: ECS Fargate + ECR

The supported AWS path is the standard ECS Fargate stack in `infra/aws/container.yaml`: a dedicated VPC, an HTTPS application load balancer with a regional ACM certificate, the `konda.com` Route 53 alias, CloudWatch logs, and one service whose container is named `site`. Its exact bootstrap, GitHub OIDC role, and environment variables are in the [README](../README.md#aws-fargate-ecr-and-route-53). `deploy-container.yml` requires that contract: a standard Fargate service using the ECS deployment controller, one container named `site`, an execution role but no application task role, and `awsvpc` networking on X86_64 Linux.

For new deployments, do not use App Runner: [AWS stopped accepting new App Runner customers on April 30, 2026](https://aws.amazon.com/apprunner/). Existing App Runner customers can still run this image with port `8080`, an ECR access role, and HTTP health checks at `/healthz`, but outside the workflow.

**Manual alternative without the stack:** ECS Express Mode provisions a Fargate service, load balancer, networking, and a provider HTTPS endpoint from a single command. It is a quick way to run the image, but it is **not compatible with `deploy-container.yml`** (which updates a standard service and task definition) and the recipe below does not bind the `konda.com` apex. Use a current AWS CLI v2 that supports `ecs create-express-gateway-service`, in a supported region. Have your infrastructure administrator provision these two roles, scoped for the deployment:

| Role | Trust principal | AWS-managed policy baseline |
| --- | --- | --- |
| Task execution role | `ecs-tasks.amazonaws.com` | `AmazonECSTaskExecutionRolePolicy` for ECR pulls and logs |
| ECS infrastructure role | `ecs.amazonaws.com` | `AmazonECSInfrastructureRoleforExpressGatewayServices` for managed infrastructure |

The deployer also needs ECR push permissions, ECS deployment permissions, and `iam:PassRole` limited to those roles. Do **not** attach an application task role or inject AWS keys into this static container; it makes no AWS API calls. The infrastructure role is not the application's runtime identity.

```sh
REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
RELEASE=release-001
EXECUTION_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/ecsTaskExecutionRole"
INFRASTRUCTURE_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/ecsInfrastructureRoleForExpressServices"

aws ecr create-repository --region "$REGION" --repository-name konda-services \
  --image-tag-mutability IMMUTABLE --image-scanning-configuration scanOnPush=true
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$REGISTRY"
IMAGE="$REGISTRY/konda-services:$RELEASE"
docker buildx build --platform linux/amd64 --provenance=false --build-arg VALIDATE_PRODUCTION=true --tag "$IMAGE" --push .

aws ecs create-express-gateway-service --region "$REGION" --service-name konda-site \
  --primary-container "image=$IMAGE,containerPort=8080" \
  --health-check-path /healthz \
  --execution-role-arn "$EXECUTION_ROLE_ARN" \
  --infrastructure-role-arn "$INFRASTRUCTURE_ROLE_ARN"
```

Wait for the service deployment to complete in ECS, then verify its HTTPS endpoint. Update an Express service to the next ECR image using its service ARN and `update-express-gateway-service`, rather than repeatedly creating services. Review regional availability, network access, scaling, and infrastructure costs before provisioning.

For an existing **standard ECS/Fargate** platform that you manage yourself instead of the included stack, use an `awsvpc` Linux task with a container named `site` on port `8080`, the task execution role, and no application task role. Use an ALB HTTPS listener with an ACM certificate, redirect HTTP to HTTPS, and set the IP target group's health check to `/healthz`. Limit task ingress to the ALB security group. If enforcing `readonlyRootFilesystem`, supply writable ephemeral storage at `/tmp` accessible to UID `101`; do not assume local Docker's `--tmpfs` option is available on Fargate. Ensure tasks can pull ECR images and send logs through approved NAT or VPC endpoints. No application changes are needed, and such a service can use the workflow once the README's IAM role and environment variables point at it.

References: [ECS deployment types](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html), [Fargate task definitions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html), [ECS Express overview](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html), [Express CLI](https://docs.aws.amazon.com/cli/latest/reference/ecs/create-express-gateway-service.html).

## Verification, updates, and rollback

With Node 24 and the project's dependencies installed, validate the real container locally:

```sh
npm run container:build
npm run test:container
```

The tests start temporary containers with a read-only filesystem and no capabilities, verify default/custom ports, Docker health checks, security headers, content, caching, MIME types, 404/405 behavior, absence of source files/Node, and rejection of unsafe ports. Test containers are removed automatically. To test another image or architecture, set `CONTAINER_IMAGE` and/or `CONTAINER_PLATFORM` (for example `linux/amd64`). Running a foreign architecture requires Docker's emulation support or a native runner. `.github/workflows/container.yml` builds and smoke-tests on Linux/AMD64 without cloud credentials; it does **not** publish or deploy an image. `.github/workflows/deploy-container.yml` is the manual release workflow; `npm test` includes its contract tests. The separate S3/CloudFront workflow stays validation-only unless the repository variable `ENABLE_AWS_STATIC_DEPLOY=true` is set, so nothing needs to be disabled for container-only hosting.

After deploying, check the real public URL:

```sh
ORIGIN=https://konda.com
curl --fail --silent --show-error "$ORIGIN/healthz"
curl --head "$ORIGIN/"
curl --head "$ORIGIN/privacy.html"
curl --head "$ORIGIN/a-page-that-does-not-exist"
npm run build && npm run verify:deployment -- --url "$ORIGIN"
```

Verify `200`, `200`, and `404` respectively for the page requests, the expected CSP/HSTS/security headers on successes **and errors**, HTTP-to-HTTPS redirection, matching canonical URLs, mobile navigation, and a real enquiry to your verified provider if configured. Use the configured privacy route if renamed. `verify:deployment` is the same check the workflow runs after a release: it compares every page and asset with the local `dist/` of the same commit, requires `/healthz`, real `404` responses (including for `/_headers` and `/site.config.json`), and the strict security headers, and rejects redirects.

Rebuild promptly for dependency/base-image security updates; Docker image digests are pinned and Dependabot tracks them weekly. Enable your registry's vulnerability scanning and retain tested image digests for rollback. Roll back by directing traffic to the previous healthy revision/task image. Container releases are self-contained: a rolling deployment or an old cached HTML page can request a CSS hash absent from a different release, so retain versioned assets at a shared CDN/origin when guaranteeing uninterrupted cross-release asset availability. Do not cache HTML as immutable or mount a mutable source tree over the runtime.