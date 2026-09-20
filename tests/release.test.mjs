import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { cacheControl } from '../scripts/verify-deployment.mjs';
import { site } from '../src/lib/config.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';

// Guards for the S3 + CloudFront release contract: the workflow, the CloudFormation template, the verifier and the
// documentation must keep agreeing on the release branch, the deployment variables and the upload metadata.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const releaseBranch = 'S3-hosting';
const deploymentVariables = ['AWS_REGION', 'AWS_ROLE_ARN', 'S3_BUCKET', 'CLOUDFRONT_DISTRIBUTION_ID', 'CLOUDFRONT_RESPONSE_HEADERS_POLICY_ID'];

test('the deployment workflow releases only from the S3-hosting branch through the protected production environment', async () => {
  const workflow = await read('.github/workflows/deploy.yml');
  assert.match(workflow, new RegExp(`^on:\\n  push:\\n    branches: \\[${releaseBranch}\\]\\n  pull_request:\\n  workflow_dispatch:\\n`, 'm'));
  const conditions = workflow.match(/^\s+if: .*$/gm);
  const releaseConditions = conditions.filter((line) => line.includes('refs/heads/'));
  assert.equal(releaseConditions.length, 3, 'production validation, artifact upload and the deploy job are release-only');
  for (const line of releaseConditions) assert.equal(line.trim(), `if: github.ref == 'refs/heads/${releaseBranch}' && github.event_name != 'pull_request'`);
  assert.ok(!workflow.includes('ENABLE_AWS_STATIC_DEPLOY'), 'S3 hosting is the only deployment path and needs no feature flag');
  assert.ok(!workflow.includes('pull_request_target'));
  assert.match(workflow, /^permissions:\n  contents: read\n/m);
  assert.equal(workflow.match(/id-token: write/g).length, 1, 'only the deploy job may mint OIDC tokens');
  assert.match(workflow, /environment:\n\s+name: production\n/);
  assert.match(workflow, /persist-credentials: false/);
  for (const uses of workflow.match(/uses: \S+/g)) assert.match(uses, /@[0-9a-f]{40}$/, `${uses} must be pinned to a commit SHA`);
  for (const name of [...deploymentVariables, 'PUBLIC_URL']) assert.ok(workflow.includes(`${name}: \${{ vars.${name} }}`), name);
  assert.match(workflow, /path: \|\n\s+dist\/\n\s+\.deploy\/\n\s+scripts\/verify-deployment\.mjs\n/, 'the verifier ships inside the artifact');
  assert.match(workflow, /node release\/scripts\/verify-deployment\.mjs --url "https:\/\/\$\{CLOUDFRONT_DOMAIN\}"/);
  assert.match(workflow, /node release\/scripts\/verify-deployment\.mjs --url "\$PUBLIC_URL" --expect-canonical/);
});

test('the workflow uploads with the same cache metadata the verifier and preview expect, never deleting or publishing ACLs', async () => {
  const workflow = await read('.github/workflows/deploy.yml');
  assert.ok(workflow.includes(`--cache-control '${cacheControl.immutable}'`));
  assert.ok(workflow.includes(`--cache-control '${cacheControl.revalidate}'`));
  assert.ok(!/--acl\b/.test(workflow), 'objects stay private; CloudFront reads them through OAC');
  assert.ok(!/--delete\b/.test(workflow), 'old hashed assets must survive so cached pages keep working');
  assert.match(workflow, /aws s3 sync release\/dist\/_astro\//);
  assert.match(workflow, /aws s3 cp release\/dist\/ "s3:\/\/\$\{S3_BUCKET\}\/" --recursive \\\n\s+--exclude '_astro\/\*'/);
  assert.match(workflow, /--if-match "\$POLICY_ETAG"/, 'header policy updates are optimistic-locked');
  assert.match(workflow, /create-invalidation[\s\S]*--paths '\/\*'/);
});

test('the CloudFormation template binds the configured domain privately behind CloudFront with the generated header defaults', async () => {
  const template = await read('infra/aws/site.yaml');
  const headers = createSecurityHeaders(site);
  assert.match(template, new RegExp(`DomainName:\\n    Type: String\\n    Default: ${new URL(site.site.url).hostname.replaceAll('.', '\\.')}\\n`), 'the default domain is the canonical site host');
  const [, defaultCsp] = template.match(/^    Default: "(default-src 'none'; .*)"$/m);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(defaultCsp));
  assert.equal(`${defaultCsp};`, headers['Content-Security-Policy'], 'bootstrap CSP equals the generated no-form policy');
  for (const [name, value] of Object.entries(headers)) {
    if (['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy'].includes(name)) continue;
    assert.ok(template.includes(`- Header: ${name}\n              Value: ${value.includes('(') ? `'${value}'` : value}\n`), `${name} bootstrap value matches the generator`);
  }
  assert.match(template, /FrameOption: DENY/);
  assert.match(template, /ReferrerPolicy: no-referrer/);
  assert.match(template, /AccessControlMaxAgeSec: 31536000\n\s+IncludeSubdomains: false/);
  for (const setting of ['BlockPublicAcls', 'BlockPublicPolicy', 'IgnorePublicAcls', 'RestrictPublicBuckets']) assert.ok(template.includes(`${setting}: true`), setting);
  assert.match(template, /ObjectOwnership: BucketOwnerEnforced/);
  assert.match(template, /SigningBehavior: always/);
  assert.match(template, /ViewerProtocolPolicy: redirect-to-https/);
  assert.match(template, /DefaultRootObject: index\.html/);
  assert.match(template, /AllowedMethods: \[GET, HEAD\]/);
  assert.equal(template.match(/ResponsePagePath: \/404\.html/g).length, 2, 'S3 403 and 404 both become the real 404 page');
  assert.equal(template.match(/HostedZoneId: Z2FDTNDATAQYW2/g).length, 2, 'A and AAAA aliases target CloudFront');
  assert.match(template, /ValidationMethod: DNS/);
  assert.match(template, /MinimumProtocolVersion: TLSv1\.2_2021/);
  assert.match(template, /'aws:SecureTransport': 'false'/);
  assert.match(template, /'AWS:SourceArn': !Sub 'arn:\$\{AWS::Partition\}:cloudfront::\$\{AWS::AccountId\}:distribution\/\$\{SiteDistribution\}'/);
  assert.ok(!/Lambda|CloudFront::Function|WebsiteConfiguration|PublicRead/.test(template), 'no edge runtime, website endpoint or public bucket');
  for (const output of ['AWSRegion', 'S3BucketName', 'CloudFrontDistributionId', 'CloudFrontDomainName', 'CloudFrontResponseHeadersPolicyId', 'SiteUrl']) {
    assert.match(template, new RegExp(`^  ${output}:\\n`, 'm'), `output ${output}`);
  }
});

test('the documentation describes this branch, the release variables and no removed hosting files', async () => {
  const readme = await read('README.md');
  const guide = await read('docs/aws-deployment.md');
  for (const document of [readme, guide]) {
    assert.ok(document.includes(releaseBranch), 'release branch is documented');
    for (const name of [...deploymentVariables, 'PUBLIC_URL']) assert.ok(document.includes(name), name);
    for (const removed of ['Dockerfile', 'compose.yaml', 'container.yaml', 'deploy-container', 'container-deployment.md', 'netlify.toml', '_headers', 'nginx', 'Nginx', 'ENABLE_AWS_STATIC_DEPLOY', 'healthz']) {
      assert.ok(!document.includes(removed), `stale reference to ${removed}`);
    }
  }
  assert.ok(readme.includes('infra/aws/site.yaml') && readme.includes('docs/aws-deployment.md'));
  assert.ok(readme.includes('npm run verify:deployment'));
  assert.ok(guide.includes('Z2FDTNDATAQYW2'), 'the DNS target zone for alias records is documented');
});
