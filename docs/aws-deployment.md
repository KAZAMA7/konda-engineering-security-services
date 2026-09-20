# AWS S3 + CloudFront hosting reference

This document explains the design behind the `S3-hosting` branch: what `infra/aws/site.yaml` provisions, what `.github/workflows/deploy.yml` does with which permissions, how caching and the security headers behave, and how to handle drift, rollback and cleanup. The step-by-step commands live in the [README runbook](../README.md#deploy-to-aws-s3-and-cloudfront); this guide is the "why" and the operations detail.

The site is only static HTML, CSS and assets. There is no application server, Lambda@Edge, CloudFront Function, S3 website endpoint, URL rewrite or AWS-hosted form handler. Non-root page links end in `.html` (for example `/privacy.html`); `/privacy` and `/privacy/` are not aliases and return the `404` page.

## Architecture

| Component | Configuration | Why |
| --- | --- | --- |
| S3 bucket (`SiteBucket`) | Dedicated, AES-256 encrypted, versioned, `BucketOwnerEnforced` (ACLs disabled), all four public-access blocks on, bucket policy denies non-TLS requests and allows `s3:GetObject` only to the CloudFront service principal with this distribution's exact `AWS:SourceArn`. Retained on stack deletion. | Nothing on the internet can read the bucket directly; only the one distribution can. Versions provide an operator-only recovery path. |
| Origin Access Control | `sigv4`, `always` sign, S3 REST regional endpoint (`RegionalDomainName`). | Signed origin requests; no legacy OAI, no public website endpoint. |
| CloudFront distribution | `redirect-to-https`, `GET`/`HEAD` only, HTTP/2 and HTTP/3, IPv6, `PriceClass_100`, `DefaultRootObject: index.html`, compression, `403` and `404` from S3 both mapped to `/404.html` with status `404` and zero error caching. | HTTPS everywhere, a real `404` for unknown keys (S3 answers `403` when the caller may not list the bucket), and no method that could mutate anything. |
| Cache policy | Min/default TTL `0`, max TTL one year, no cookies, headers or query strings in the cache key, gzip/brotli normalisation. | CloudFront honours each object's `Cache-Control`: pages revalidate, hashed assets are cached for a year. Viewer inputs never reach the origin. |
| Response headers policy | CSP (from the build), HSTS `max-age=31536000`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`; all `Override: true`. | S3 cannot emit these headers; the policy adds them to every response, including error pages. The workflow refreshes it on each release so it always matches the deployed HTML. |
| ACM certificate | Issued by the stack (DNS validation in the given Route 53 zone) or supplied as `AcmCertificateArn`; `TLSv1.2_2021`, SNI. | CloudFront requires the certificate in `us-east-1`; the stack therefore runs there when it issues the certificate. |
| Route 53 records | Apex `A` and `AAAA` alias records to the distribution (alias hosted zone `Z2FDTNDATAQYW2`) when `HostedZoneId` is set. | An apex cannot be a CNAME; Route 53 aliases resolve directly to CloudFront's addresses, for IPv4 and IPv6. |

### Template parameters and modes

| Mode | `DomainName` | `HostedZoneId` | `AcmCertificateArn` | Result |
| --- | --- | --- | --- | --- |
| Route 53 managed (recommended) | `konda.com` | public zone ID | empty | Certificate requested, validated and renewed automatically; apex records created; `SiteUrl` = `https://konda.com`. Stack must be in `us-east-1`. |
| External DNS | `konda.com` | empty | issued `us-east-1` certificate ARN | Certificate attached; you point the apex at `CloudFrontDomainName` with your provider's ALIAS/ANAME feature and keep the validation CNAME for renewals. |
| No custom domain | empty | empty | empty | Only the `*.cloudfront.net` hostname with CloudFront's default certificate; add the domain later with a stack update. |

A template rule rejects any other combination. `ContentSecurityPolicy` must always be the current build's `.deploy/csp.txt`: the template's default equals the generated no-form policy, but a configured form provider changes it. The template creates no IAM resources, so `aws cloudformation deploy` needs no capability flags.

Stack outputs map to the GitHub `production` environment variables as follows: `AWSRegion` → `AWS_REGION`, `S3BucketName` → `S3_BUCKET`, `CloudFrontDistributionId` → `CLOUDFRONT_DISTRIBUTION_ID`, `CloudFrontResponseHeadersPolicyId` → `CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID`, and `SiteUrl` → `PUBLIC_URL` once DNS resolves. `AWS_ROLE_ARN` comes from the separately created IAM role. `CloudFrontDomainName` is the DNS target and is also served directly over HTTPS; `CertificateArn` and the ARN outputs are informational.

## Build contract

- Node 24 from `.nvmrc` and the committed lockfile: `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run validate:production`.
- `dist/index.html` and `dist/404.html` must exist; other routes are flat `.html` files. Only content-hashed immutable assets live in `dist/_astro/`. No file outside `_astro/` may start with `.` or `_`, because **every file in `dist/` is uploaded** and served.
- The build writes `.deploy/csp.txt`, `.deploy/response-headers-policy.json` (CloudFront `ResponseHeadersPolicyConfig` **without `Name`**: `Comment`, `SecurityHeadersConfig`, `CustomHeadersConfig` with `Quantity` and `Items`), and `.deploy/security-headers.json` (the same policy as a header map). `scripts/verify-build.mjs` checks that all three agree with the generator, and the workflow re-checks the policy shape, CSP length (CloudFront limit 1,783 characters) and the absence of `unsafe-inline`/`unsafe-eval`.
- `src/styles/global.css` limits Tailwind's class sources to `src/**/*.astro`, so a build of a commit is byte-identical on every machine. The verifier compares the live site with a local build of the same commit, which only works because of this.
- `npm run validate:production` refuses placeholder domains and missing contact channels; the workflow runs it before every release build and there is no bypass. Passing it does not prove domain ownership or contact reachability.

## Release workflow

`.github/workflows/deploy.yml` runs on pushes to `S3-hosting`, on pull requests, and on manual dispatch. Only a push or manual run **on `S3-hosting`** may release; every other run stops after building and testing.

**Build job** — `contents: read`, no AWS access, `persist-credentials: false`: `npm ci`, type check, unit and release-contract tests, production validation (release runs only), build, Playwright Chromium tests, the release-contract check of the generated policy, then one artifact containing `dist/`, `.deploy/` and `scripts/verify-deployment.mjs`, retained 14 days.

**Deploy job** — `environment: production`, `id-token: write`, serialized (`aws-site-production`, never cancelled by a newer push), 60-minute limit. It does not check out the repository or install npm packages: everything it runs is the reviewed artifact plus the AWS CLI and Node built-ins.

1. Require the five variables; validate `PUBLIC_URL` if present.
2. Assume `AWS_ROLE_ARN` with the GitHub OIDC token (one hour, account ID masked).
3. Read the distribution and the response headers policy. Fail unless the distribution is enabled, has `index.html` as root object, redirects to HTTPS, has no extra cache behaviours, uses `S3_BUCKET` in `AWS_REGION` as its OAC origin, has the configured policy attached, and — when `PUBLIC_URL` is set — lists its host among the aliases. Keep the policy `Name` and `ETag`.
4. `aws s3 sync dist/_astro/ → s3://bucket/_astro/` with `Cache-Control: public, max-age=31536000, immutable`, **without `--delete`**: hashed assets from earlier releases stay available for cached pages.
5. `aws s3 cp dist/ → s3://bucket/ --recursive --exclude '_astro/*'` with `Cache-Control: no-cache, max-age=0, must-revalidate`. Copying (rather than change-detection sync) reapplies metadata every release; the CLI sets `Content-Type` from the extension (`.html` → `text/html`, `.css` → `text/css`, `.svg` → `image/svg+xml`, …). No `--acl` is used anywhere.
6. `update-response-headers-policy` with the generated configuration merged with the existing `Name`, guarded by `--if-match <ETag>`: a concurrent change fails the release instead of being overwritten.
7. Wait for the distribution, `create-invalidation --paths '/*'`, wait for completion.
8. Run `scripts/verify-deployment.mjs` against `https://<distribution>.cloudfront.net` (30 attempts, 10 s apart) and, when `PUBLIC_URL` is set, against the domain with `--expect-canonical`. The verifier is described below.
9. Write the bucket, distribution, and verified URL to the run summary.

### What the verifier proves

`scripts/verify-deployment.mjs` needs only Node.js. It reads `dist/` and `.deploy/security-headers.json`, checks that every HTML page carries an absolute HTTPS canonical URL on one origin whose path equals its route, and then requests, in parallel with bounded retries and timeouts:

- every built file, expecting `200`, the exact bytes, the expected `Content-Type` family, and the exact `Cache-Control` (`immutable` for `_astro/`, revalidation for everything else);
- `/index.html` as an alias of `/`;
- a random unknown `.html` path, `/missing-directory/`, `/site.config.json` and `/.deploy/csp.txt`, expecting `404` with the bytes of `404.html`;
- every generated security header on **every** response, including the `404`s;
- `http://<host>/` answering `301`/`308` to `https://<host>/`.

Redirects are never followed. `--expect-canonical` additionally requires the verified origin to equal the canonical origin built into the pages, so the domain probe fails if `site.url` and the public hostname disagree. Run it by hand with `npm run verify:deployment -- --url https://konda.com --expect-canonical` after `npm run build` of the same commit, or against the local preview with `--allow-local`.

## GitHub OIDC role and least privilege

The role's trust policy accepts `sts:AssumeRoleWithWebIdentity` from the account's `token.actions.githubusercontent.com` provider only when the audience is `sts.amazonaws.com` and the subject is exactly `repo:KAZAMA7/konda-engineering-security-services:environment:production`. An environment-scoped subject does not contain the branch, so the `production` environment must restrict deployment branches to `S3-hosting` and require reviewers; the workflow's own branch condition is a second, independent gate. Do not use `repo:OWNER/REPO:*`, allow forks, or use `pull_request_target`.

The permission policy grants exactly:

| Actions | Resource | Used for |
| --- | --- | --- |
| `s3:ListBucket`, `s3:GetBucketLocation` | the bucket | `aws s3 sync`/`cp` listing and region discovery |
| `s3:PutObject`, `s3:AbortMultipartUpload` | objects in the bucket | uploads and cleanup of failed multipart uploads |
| `cloudfront:GetDistribution`, `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` | this distribution | target checks, waiters and invalidation |
| `cloudfront:GetResponseHeadersPolicy`, `cloudfront:UpdateResponseHeadersPolicy` | this response headers policy | applying the generated headers |

The role cannot delete objects or versions, read site objects, set ACLs, change the bucket policy, update the distribution, manage IAM, DNS or CloudFormation. Keep the response headers policy dedicated to this distribution; sharing it would extend the effect of a permitted update. Never store AWS access keys in GitHub.

## Caching and invalidation

Pages and unhashed assets carry `no-cache, max-age=0, must-revalidate`; browsers and CloudFront revalidate them, and the release invalidates `/*` anyway so new HTML is visible immediately. `_astro/*` files are content-hashed and `immutable` for a year; because old hashes are never deleted, a page cached by a browser or intermediary before a release still finds its stylesheet afterwards. The `/*` invalidation also evicts hashed assets from CloudFront's cache (they are re-fetched from S3 once) but does not remove anything from the bucket. One invalidation path per release stays within CloudFront's free monthly allowance.

Error responses are not cached by CloudFront (`ErrorCachingMinTTL: 0`, with S3 origins still subject to CloudFront's one-second floor), so a page published after a `404` is visible right away.

## Drift, updates and rollback

**The workflow owns the deployed response headers after bootstrap.** CloudFormation still owns the policy resource, so every stack update must pass the current `.deploy/csp.txt` (rebuild first) and the same domain parameters; otherwise the update resets the policy to the template defaults and can drop a configured form origin. Re-run the release after any stack update to restore the exact generated policy, and never run a stack update and a release concurrently. Review drift rather than automatically resetting it.

A release is not an atomic transaction: uploads, the policy update, the invalidation and verification happen in sequence. A failed step leaves a partially published release visible to the operator in the run log and summary; there is no automatic rollback. Fix forward or roll back by reverting the commit on `S3-hosting` and letting the workflow republish HTML, assets and header policy together — do not roll back only the HTML when the CSP or form endpoint changed. Re-running an older successful workflow run republishes that commit exactly (its artifact is kept for 14 days). Bucket versioning is a further operator-only path: restore a consistent set of objects, then invalidate.

## Retention, cost and cleanup

Nothing is deleted automatically, including pages you remove from the configuration: an operator must delete the object and invalidate its path, and consider retained versions. Old `_astro/` hashes accumulate; prune them only after browser/CDN cache lifetimes and your rollback window have passed. The bucket and its versions survive stack deletion and keep costing money until removed. Costs are S3 storage and requests, CloudFront requests and transfer in `PriceClass_100`, the Route 53 hosted zone, and invalidations beyond the free allowance; ACM is free. Logging, alarms, WAF and automated retention are not included.

To decommission: remove or repoint DNS, delete the stack, then empty and delete the retained bucket (all versions), delete the IAM role and, if unused elsewhere, the OIDC provider, certificate and hosted zone.

## Form-provider safety

Only an explicitly configured public HTTPS endpoint from a trusted provider is allowed; never place API secrets in configuration, HTML, build artifacts or GitHub variables. The generator limits `form-action` to the provider's origin, not a URL path. Changing the provider changes the CSP, which requires a release (pages and header policy together) and a stack update with the new `csp.txt` before any later infrastructure change. Do not widen the CSP to `*`, add `unsafe-inline`/`unsafe-eval`, or give the site a server runtime to work around a provider problem. The provider owns validation, spam and rate limiting, storage and retention; test a real enquiry on the deployed domain — a passing verifier does not prove delivery of submissions.

## Local validation

`actionlint .github/workflows/deploy.yml` and `cfn-lint infra/aws/site.yaml` (for example `uvx --from cfn-lint cfn-lint infra/aws/site.yaml`) validate syntax and schema without credentials. `npm test` includes `tests/release.test.mjs`, which pins the release branch, the variable names, the upload metadata and the template's security settings, and `tests/verify-deployment.test.mjs`, which exercises the verifier against a loopback stand-in for S3 behind CloudFront. None of this proves IAM permissions, DNS delegation, certificate issuance or GitHub protection rules in your account; the first real release on `https://<distribution>.cloudfront.net` and the domain check in the README do.
