# AWS deployment

This deploys only static HTML, CSS and assets. There is no application server, Lambda@Edge, CloudFront Function, S3 website endpoint, URL rewrite or AWS-hosted form handler. Non-root page links must end in `.html`, for example `/privacy.html`; `/privacy` and `/privacy/` are not aliases.

## Prerequisites and build contract

- A commercial AWS account, AWS CLI v2, and an operator identity permitted to create/update the CloudFormation resources and separately configure IAM/OIDC. Do not give these administrative permissions to CI.
- Node 24 from `.nvmrc`, the committed npm lockfile, and the parent project's implemented scripts: `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`, and `npm run validate:production`.
- `dist/index.html` and `dist/404.html` must exist. Other routes are `.html` files. Only content-hashed immutable assets belong in `dist/_astro/`.
- The build must generate `.deploy/csp.txt` and `.deploy/response-headers-policy.json`. The JSON is the **CloudFront API** `ResponseHeadersPolicyConfig` shape **without `Name`**, with `SecurityHeadersConfig`, `CustomHeadersConfig.Quantity`, `CustomHeadersConfig.Items`, and optional `Comment`. The current generator supplies three custom headers; all are deployed, not just `Permissions-Policy`.
- The generated CSP must match `csp.txt`, fit CloudFront's default 1,783-character limit, and contain neither `unsafe-inline` nor `unsafe-eval`. The workflow checks mandatory security headers and preserves the existing AWS policy's name.
- Browser fixtures in `.test-build` are not deployable artifacts. Only `dist/` and `.deploy/` are uploaded; the hidden `.deploy` directory is explicitly included. Never put credentials or private data in either directory. `dist/_headers` is for other hosts and is excluded from every S3 upload.
- Before a production build, configure `site.config.json` with the real canonical HTTPS URL and at least a real email address or external HTTPS form endpoint. `npm run validate:production` must pass; CI will not bypass it.

## Bootstrap the infrastructure

Run these commands from the repository root with your operator identity, not the CI role. The examples use `us-east-1` for the bucket, but the bucket can be in another commercial region. CloudFront and its response/cache policies are global.

```bash
export AWS_PROFILE=your-operator-profile
export AWS_REGION=us-east-1
export AWS_PAGER=''
export AWS_CLI_AUTO_PROMPT=off
export STACK_NAME=consultancy-site

npm ci
npm run check
npm test
npm run build

aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/aws/site.yaml \
  --parameter-overrides "ContentSecurityPolicy=$(< .deploy/csp.txt)" \
  --no-fail-on-empty-changeset

aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
```

This template creates no IAM resources, so no IAM capability flag is needed. The commands do create billable resources and are for the operator to run deliberately. No AWS resources were deployed while authoring these files.

When using the default CloudFront hostname, obtain `SiteUrl` from the stack output, set it as the canonical URL in `site.config.json`, configure the public contact details, and rerun `npm run validate:production` and `npm run build`. The initial bootstrap build only supplies the CSP and does not publish placeholder pages. An empty bucket will not serve a usable site until the first approved deployment uploads `index.html` and `404.html`.

The bucket is dedicated, AES-256 encrypted, versioned, ACL-disabled, and has all four public-access blocks enabled. Its policy denies non-TLS requests and grants only `s3:GetObject` to the CloudFront service principal with this distribution's exact `AWS:SourceArn`. OAC always signs origin requests using SigV4 against the regional S3 REST endpoint. The CI role's separately scoped IAM permissions allow uploads; direct anonymous S3 reads remain forbidden.

CloudFront redirects HTTP to HTTPS, serves `/` as `index.html`, compresses content, and converts origin 403 and 404 responses to a real HTTP 404 using `/404.html`. S3 often returns 403 for nonexistent keys because CloudFront has no bucket-list permission. An origin-access misconfiguration can therefore also appear as a 404: investigate OAC and the bucket policy rather than making the bucket public. `ErrorCachingMinTTL` is zero; S3 origins still have CloudFront's one-second error-cache floor.

### Optional custom domain

Request and DNS-validate an ACM certificate **in `us-east-1`**, in the same account as the distribution, covering the exact hostname. Wait until it is issued. Set the canonical URL/contact configuration, rebuild, then use both optional parameters:

```bash
export CUSTOM_DOMAIN=www.your-real-domain.com
export ACM_CERTIFICATE_ARN=arn:aws:acm:us-east-1:123456789012:certificate/replace-with-issued-certificate-id

npm run validate:production
npm run build
aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/aws/site.yaml \
  --parameter-overrides \
    "ContentSecurityPolicy=$(< .deploy/csp.txt)" \
    "CustomDomainName=$CUSTOM_DOMAIN" \
    "AcmCertificateArn=$ACM_CERTIFICATE_ARN" \
  --no-fail-on-empty-changeset
```

Both domain parameters must be empty or both supplied. This configures one alias and does not request a certificate, manage DNS, or redirect alternate hostnames. Create Route 53 alias A/AAAA records to `CloudFrontDomainName` (CloudFront hosted zone ID `Z2FDTNDATAQYW2`), or a CNAME for a non-apex hostname with your DNS provider. An apex needs an alias/ANAME-capable provider. Keep ACM validation records for renewal. Avoid proxying the record through another CDN unless you separately verify its caching and headers.

The default CloudFront hostname remains usable without custom-domain setup. Custom-domain connections use the `TLSv1.2_2021` minimum policy; the default CloudFront certificate uses AWS's service-managed default-domain TLS policy. The template uses `PriceClass_100`; review edge-location coverage and costs before changing it.

## GitHub OIDC and least-privilege IAM

Create the GitHub environment named **`production` before enabling deployment**. Restrict its deployment branches to **only `main`**, configure required reviewers, prevent self-review, and disable administrator protection-rule bypass where your GitHub plan permits. If your repository/plan cannot enforce these rules, do not treat deployment as approval-protected. Protect `main` and require review of the workflow, infrastructure, site configuration, and build/header generator changes.

An account-level IAM OIDC provider for `https://token.actions.githubusercontent.com` with client ID/audience `sts.amazonaws.com` may already exist. Reuse it; do not create a duplicate. If absent, an IAM administrator must create it using AWS's current GitHub OIDC instructions. It is not provisioned by the site stack.

Create a dedicated role, for example `github-consultancy-production`, with a one-hour maximum session duration. Replace `123456789012`, `OWNER`, and `REPOSITORY` in this trust policy exactly; do not use wildcard subjects:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPOSITORY:environment:production"
        }
      }
    }
  ]
}
```

With an environment-scoped subject, the branch is **not** present in the OIDC `sub` claim. Environment branch restrictions and approval rules are therefore essential, in addition to the workflow's own `main`/non-PR condition. Do not replace this with `repo:OWNER/REPOSITORY:*`, permit a fork, or use `pull_request_target`.

Attach this inline permission policy to the role, replacing `BUCKET_NAME`, `DISTRIBUTION_ID`, `POLICY_ID`, and the account ID with the exact stack outputs. No wildcard resource is needed except objects **inside the dedicated bucket**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListDedicatedBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::BUCKET_NAME"
    },
    {
      "Sid": "UploadDedicatedSiteObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::BUCKET_NAME/*"
    },
    {
      "Sid": "VerifyAndInvalidateOnlyThisDistribution",
      "Effect": "Allow",
      "Action": [
        "cloudfront:GetDistribution",
        "cloudfront:CreateInvalidation",
        "cloudfront:GetInvalidation"
      ],
      "Resource": "arn:aws:cloudfront::123456789012:distribution/DISTRIBUTION_ID"
    },
    {
      "Sid": "ReadAndUpdateOnlyThisResponseHeadersPolicy",
      "Effect": "Allow",
      "Action": [
        "cloudfront:GetResponseHeadersPolicy",
        "cloudfront:UpdateResponseHeadersPolicy"
      ],
      "Resource": "arn:aws:cloudfront::123456789012:response-headers-policy/POLICY_ID"
    }
  ]
}
```

The role cannot delete objects/versions, read site objects directly, set ACLs, alter the bucket policy, update a distribution, manage IAM, or operate CloudFormation. Multipart-upload abort permission allows cleanup of failed large asset uploads. Do not attach a general S3/CloudFront administrator policy or store AWS access keys in GitHub secrets. The response policy must remain dedicated to this site; sharing it with other distributions would extend the effect of a permitted policy update.

### Production environment variables

Add the following under repository settings → Environments → `production` → Environment variables. These are configuration values, not static AWS secrets.

| Variable | Value |
| --- | --- |
| `AWS_REGION` | `AWSRegion` stack output: the bucket/stack region |
| `AWS_ROLE_ARN` | ARN of the separately created deployment role |
| `S3_BUCKET` | `S3BucketName` stack output |
| `CLOUDFRONT_DISTRIBUTION_ID` | `CloudFrontDistributionId` stack output |
| `CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID` | `CloudFrontResponseHeadersPolicyId` stack output |

The ARN outputs are provided for the IAM permission policy. `CloudFrontDomainName` is the DNS target; `SiteUrl` is the canonical URL to put in site configuration. The workflow verifies the configured bucket/region is the default distribution origin and the configured policy is attached before it writes anything.

## CI and release behavior

`.github/workflows/deploy.yml` runs on pushes to `main`, pull requests, and manual dispatch. The build job has only repository-read permissions and never assumes an AWS role. It installs with `npm ci`, checks types, runs unit/security tests, validates production configuration for main releases, builds, installs Playwright Chromium with its OS dependencies, runs browser tests, and checks the AWS artifact contract. All action references are pinned to upstream-verified commit SHAs; the annotated AWS credentials tag was resolved to its underlying commit. These actions require a runner supporting Node 24 and target GitHub.com, not older GHES runners.

Only a successful main/non-PR build can reach the separate environment-gated deployment job. Only that job has `id-token: write`; it downloads the artifact from the same workflow run and does not check out or execute npm dependencies with AWS credentials. PR validation can be superseded, but an active production deployment is not cancelled by a newer push. Production deployments are serialized.

Publishing proceeds as follows:

1. Read the exact distribution and response policy, validate the target relationship, and retain the policy's `Name` and `ETag`.
2. Sync `_astro/` first with `Cache-Control: public, max-age=31536000, immutable`, **without `--delete`**, so older HTML can still load old hashed assets.
3. Copy all other public files with `Cache-Control: no-cache, max-age=0, must-revalidate`, excluding `_astro/` and every `_headers` file. AWS CLI MIME detection remains enabled (`.html` → `text/html`, `.css` → `text/css`, and so on). Copying mutable files rather than change-detection-only sync reapplies cache/MIME metadata every release. Nothing uses `--acl`.
4. Merge the generated header settings, including all custom headers and `Comment`, with the existing `Name`, then update only the configured policy using `--if-match` and its captured `ETag`. A concurrent policy change fails rather than silently overwriting another operator's change.
5. Wait for the distribution, invalidate `/*`, and wait for invalidation completion. The wildcard covers `/`, `.html` pages, unhashed assets and cached 404s; it also evicts cached hashed assets, but does not remove them from S3.
6. Retry live HTTPS probes against the CloudFront hostname for `/`, `/index.html`, and a nonexistent `.html` path. Verify exact deployed page bodies, HTML MIME types, the generated CSP/custom headers, HSTS, nosniff, frame protection, referrer policy and HTTP 404. A distribution waiter alone cannot prove response-policy propagation; the live checks are an additional gate, not proof of all global edge locations.

The custom cache policy has minimum/default TTL zero, so CloudFront respects revalidation on mutable files while allowing a one-year lifetime for hashed assets. Query strings, cookies and viewer headers are not forwarded as application inputs. Form submissions must go directly to the configured external provider; this distribution accepts only GET/HEAD.

## Stack updates, drift, rollback and cleanup

**The workflow owns the deployed response-header settings after bootstrap.** CloudFormation still owns the policy resource, so workflow updates can cause intentional drift. Always rebuild the approved current configuration and supply the current `.deploy/csp.txt` as `ContentSecurityPolicy` on subsequent stack operations. Preserve the custom-domain parameters when applicable; never reset to a default CSP that omits current script/style hashes or the configured form origin. A stack update can reapply bootstrap values for other headers too: rerun the approved deployment afterwards to restore the entire generated policy and verify it. Do not concurrently run stack updates and production deployment. Detect/review drift rather than automatically resetting the policy to the template defaults.

Deployment is not an atomic multi-object transaction. Failed uploads, ETag conflicts, invalidation failures, or policy propagation can leave a partially published release. New CSP hashes may temporarily block older cached pages, and vice versa; it fails closed instead of adding `unsafe-inline`. Keep frontend changes tolerant of mixed versions. There is no automatic rollback.

For a routine rollback, revert the content/code change through a reviewed commit on `main`, preserving a valid canonical URL and contact configuration. Let the normal production-validated, approved workflow rebuild and deploy the matching HTML **and generated policy**, invalidate and verify. Do not roll back only the HTML when script/style hashes or the form endpoint changed. GitHub release artifacts are retained for 14 days; extend retention or archive approved releases if longer recovery is needed. A historical rerun can republish old configuration, so reviewers must check exactly which commit/configuration is being approved.

S3 versioning provides an additional operator-only recovery path. Restore a consistent approved set of HTML/unhashed objects together with its matching generated policy, then invalidate and verify; restoring one object version alone is not a complete site rollback. The CI role deliberately has no version-reading or deletion permissions.

**No objects are automatically deleted**, including removed mutable paths. This favors recovery and least privilege, but a retired page remains publicly reachable until an operator deliberately deletes that specific key and invalidates its path. For urgent content removal, remove the source first, delete the live key using an operator identity, invalidate, verify HTTP 404, and review retained versions against your retention requirements. Never use a blanket bucket sync with `--delete` or delete `_astro/` on each release. Garbage-collect old hashes only after accounting for browser/CDN cache lifetimes and all supported rollback releases.

The bucket and its versions are retained on stack deletion/replacement and continue to incur charges. An operator must separately inventory and remove retained data when decommissioning; deletion of the stack is not data erasure. Monitor storage growth, CloudFront requests/transfer and invalidation costs. Logging, monitoring/alarms, WAF, DNS provisioning and automated data-retention management are not included.

## Form-provider safety

Use only an explicitly configured public HTTPS endpoint from a trusted provider; never embed API secrets in configuration, HTML, build artifacts or GitHub environment variables. The generator limits `form-action` to the configured endpoint's HTTPS origin, not its exact URL path. Changing provider/origin requires a fresh build, header-policy update, validation and release. Do not broaden the CSP to `*`, add `unsafe-inline`/`unsafe-eval`, or grant this site a server runtime just to bypass a provider integration problem.

The external provider owns submission validation, spam/rate limiting, storage, retention and abuse controls. Check its privacy terms and data location, avoid sensitive financial/identity data, and test redirects, validation failures and browser behavior on the real deployed origin. A successful static-site probe does not verify delivery of form submissions. A real email contact is a valid alternative when no form provider is configured.

## Local validation and deployment limits

Run `cfn-lint infra/aws/site.yaml` and `actionlint .github/workflows/deploy.yml` when changing this slice. These are local schema/static checks and do not require AWS credentials. They do not establish that IAM permissions, certificate ownership, DNS, GitHub protection rules or global CDN propagation work in the target account. The parent project owns whole-site tests and final integration validation. Live AWS provisioning and publishing require the operator setup above and have not been performed as part of this implementation.