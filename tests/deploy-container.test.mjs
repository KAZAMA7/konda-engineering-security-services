import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  assertEcsDeploymentReady,
  assertTestedImage,
  createEcsTaskDefinition,
  deployContainer,
  isAzureDeploymentReady,
  isGcpDeploymentReady,
  pushedImageReference,
  validateDeploymentConfig,
  validatePublicOrigin,
  validateSelection,
} from '../scripts/deploy-container.mjs';
import { verifyDeployment } from '../scripts/verify-deployment.mjs';
import { site } from '../src/lib/config.mjs';
import { createSecurityHeaders } from '../src/lib/security.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const image = `123456789012.dkr.ecr.eu-west-1.amazonaws.com/konda-services@${digest}`;
const previousTask = 'arn:aws:ecs:eu-west-1:123456789012:task-definition/konda:1';
const nextTask = 'arn:aws:ecs:eu-west-1:123456789012:task-definition/konda:2';
const common = {
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '12345678', GITHUB_RUN_ATTEMPT: '2',
  CONTAINER_PUBLIC_URL: 'https://konda.com',
};
const providers = {
  aws: {
    AWS_REGION: 'eu-west-1', AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/github-deploy',
    AWS_ECR_REPOSITORY: 'konda-services', AWS_ECS_CLUSTER: 'konda', AWS_ECS_SERVICE: 'site',
  },
  azure: {
    AZURE_CLIENT_ID: '11111111-1111-1111-1111-111111111111',
    AZURE_TENANT_ID: '22222222-2222-2222-2222-222222222222',
    AZURE_SUBSCRIPTION_ID: '33333333-3333-3333-3333-333333333333',
    AZURE_RESOURCE_GROUP: 'konda-rg', AZURE_CONTAINER_APP: 'konda', AZURE_ACR_NAME: 'konda12345',
  },
  gcp: {
    GCP_PROJECT_ID: 'konda-project', GCP_REGION: 'europe-west1',
    GCP_ARTIFACT_REPOSITORY: 'konda-services', GCP_CLOUD_RUN_SERVICE: 'konda',
    GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123456789/locations/global/workloadIdentityPools/github/providers/github',
    GCP_DEPLOY_SERVICE_ACCOUNT: 'github-deploy@konda-project.iam.gserviceaccount.com',
  },
};
const environment = (cloud) => ({ ...common, DEPLOY_CLOUD: cloud, ...providers[cloud] });
const taskDefinition = () => ({
  family: 'konda', executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
  networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], cpu: '256', memory: '512',
  runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
  containerDefinitions: [
    { name: 'site', image: 'old:tag', essential: true, portMappings: [{ containerPort: 8080 }] },
    { name: 'sidecar', image: 'sidecar:tag', essential: false },
  ],
  volumes: [], placementConstraints: [], ephemeralStorage: { sizeInGiB: 30 },
  enableFaultInjection: false, pidMode: 'task',
  taskDefinitionArn: previousTask, revision: 1, status: 'ACTIVE',
  requiresAttributes: [], compatibilities: ['EC2', 'FARGATE'],
  registeredAt: '2026-01-01T00:00:00Z', registeredBy: 'arn:aws:iam::123456789012:root',
});
const ecsService = (task = nextTask) => ({
  status: 'ACTIVE', launchType: 'FARGATE', deploymentController: { type: 'ECS' },
  taskDefinition: task, desiredCount: 1, runningCount: 1, pendingCount: 0,
  deployments: [{ status: 'PRIMARY', taskDefinition: task, rolloutState: 'COMPLETED' }],
});
const azureState = (reference = image, name = 'konda--new') => ({
  app: { properties: {
    configuration: { activeRevisionsMode: 'Single' },
    template: { containers: [{ name: 'site', image: reference }] },
    provisioningState: 'Succeeded', latestRevisionName: name, latestReadyRevisionName: name,
  } },
  revision: { name, properties: {
    active: true, provisioningState: 'Provisioned', healthState: 'Healthy',
    template: { containers: [{ name: 'site', image: reference }] },
  } },
});
const gcpState = (reference = image, name = 'konda-00002-abc') => ({
  service: {
    metadata: { generation: 2 }, spec: { template: { spec: { containers: [{ image: reference }] } } },
    status: {
      observedGeneration: 2, conditions: [{ type: 'Ready', status: 'True' }],
      latestCreatedRevisionName: name, latestReadyRevisionName: name,
      traffic: [{ revisionName: name, percent: 100, latestRevision: true }],
    },
  },
  revision: {
    metadata: { name, generation: 1 }, spec: { containers: [{ image: reference }] },
    status: { observedGeneration: 1, conditions: [{ type: 'Ready', status: 'True' }], imageDigest: reference },
  },
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(process.cwd(), 'tests/.deployment-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('every cloud requires all common and provider-specific configuration before deployment', async (t) => {
  for (const cloud of Object.keys(providers)) {
    const env = environment(cloud);
    const config = validateDeploymentConfig(env);
    assert.equal(config.cloud, cloud);
    assert.equal(config.publicUrl, common.CONTAINER_PUBLIC_URL);
    assert.equal(config.releaseTag, `sha-${common.GITHUB_SHA}-run-12345678-2`);
    for (const key of ['CONTAINER_PUBLIC_URL', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', ...Object.keys(providers[cloud])]) {
      await t.test(`${cloud}: ${key} is required`, () => {
        for (const value of [undefined, '', '  ']) assert.throws(() => validateDeploymentConfig({ ...env, [key]: value }), new RegExp(key));
      });
    }
    for (const key of Object.keys(providers[cloud])) {
      assert.throws(() => validateDeploymentConfig({ ...env, [key]: 'bad;$(command)\nvalue' }), new RegExp(key));
    }
  }
});

test('only a supported manually dispatched main-branch release is accepted', () => {
  for (const cloud of ['', 'AWS', 'digitalocean', 'aws;exit 0']) {
    assert.throws(() => validateSelection({ ...environment('aws'), DEPLOY_CLOUD: cloud }), /cloud/i);
  }
  for (const ref of [undefined, 'refs/heads/feature', 'refs/tags/main', 'main']) {
    assert.throws(() => validateSelection({ ...environment('aws'), GITHUB_REF: ref }), /main/);
  }
  for (const event of [undefined, 'push', 'pull_request', 'pull_request_target']) {
    assert.throws(() => validateSelection({ ...environment('aws'), GITHUB_EVENT_NAME: event }), /workflow_dispatch/);
  }
  for (const [key, value] of [['GITHUB_SHA', 'main'], ['GITHUB_RUN_ID', '-1'], ['GITHUB_RUN_ATTEMPT', '0']]) {
    assert.throws(() => validateDeploymentConfig({ ...environment('aws'), [key]: value }), new RegExp(key));
  }
});

test('AWS accepts native ECS names or matching resource ARNs without crossing accounts or regions', () => {
  const env = {
    ...environment('aws'),
    AWS_ECS_CLUSTER: 'arn:aws:ecs:eu-west-1:123456789012:cluster/konda',
    AWS_ECS_SERVICE: 'arn:aws:ecs:eu-west-1:123456789012:service/konda/site',
  };
  assert.equal(validateDeploymentConfig(env).env.AWS_ECS_SERVICE, env.AWS_ECS_SERVICE);
  for (const name of ['AWS_ECS_CLUSTER', 'AWS_ECS_SERVICE']) {
    for (const value of [env[name].replace('eu-west-1', 'us-east-1'), env[name].replace('123456789012', '999999999999')]) {
      assert.throws(() => validateDeploymentConfig({ ...env, [name]: value }), new RegExp(name));
    }
  }
});

test('public origins reject redirects, paths, credentials, local targets and URL normalization tricks', () => {
  for (const value of ['https://konda.com', 'https://konda.com/', 'https://service-abc.run.app']) {
    assert.equal(validatePublicOrigin(value), value.replace(/\/$/, ''));
  }
  for (const value of [
    '', 'http://konda.com', 'https://user:pass@konda.com', 'https://konda.com/path',
    'https://konda.com/../', 'https://konda.com/%2e%2e/', 'https://konda.com?', 'https://konda.com#',
    'https://konda.com:443', 'https://konda.com:8443', 'https://konda.com\\@evil.com',
    ' https://konda.com', 'https://konda.com\n', 'https://127.0.0.1', 'https://2130706433',
    'https://[::1]', 'https://localhost', 'https://host.internal', 'https://host.local',
  ]) assert.throws(() => validatePublicOrigin(value), /origin/i, value);
  assert.equal(validatePublicOrigin('http://127.0.0.1:8123', { allowLocal: true }), 'http://127.0.0.1:8123');
  assert.equal(validatePublicOrigin('http://[::1]:8123/', { allowLocal: true }), 'http://[::1]:8123');
  for (const value of ['http://konda.com', 'http://192.168.1.1:8080', 'http://127.0.0.1:8080/path']) {
    assert.throws(() => validatePublicOrigin(value, { allowLocal: true }), /origin/i);
  }
});

test('only the exact tested Linux amd64 image and a unique pushed digest are accepted', () => {
  const metadata = { Id: imageId, Os: 'linux', Architecture: 'amd64' };
  assert.doesNotThrow(() => assertTestedImage(metadata, imageId));
  for (const changed of [{ Id: digest }, { Os: 'windows' }, { Architecture: 'arm64' }]) {
    assert.throws(() => assertTestedImage({ ...metadata, ...changed }, imageId), /tested|linux\/amd64/);
  }
  const repository = image.split('@')[0];
  assert.equal(pushedImageReference(repository, [image, `other.registry/site@${digest}`]), image);
  for (const values of [[], [repository], [`${repository}:latest`], [`${repository}@sha256:no`], [image, image]]) {
    assert.throws(() => pushedImageReference(repository, values), /digest/i);
  }
});

test('ECS preserves mutable task settings, changes only site, and drops all response-only fields', () => {
  const original = taskDefinition();
  const next = createEcsTaskDefinition(original, image);
  assert.equal(original.containerDefinitions[0].image, 'old:tag');
  assert.equal(next.containerDefinitions[0].image, image);
  assert.deepEqual(next.containerDefinitions[1], original.containerDefinitions[1]);
  for (const key of ['family', 'executionRoleArn', 'networkMode', 'cpu', 'memory', 'requiresCompatibilities', 'runtimePlatform', 'volumes', 'placementConstraints', 'ephemeralStorage', 'enableFaultInjection', 'pidMode']) {
    assert.deepEqual(next[key], original[key], key);
  }
  for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities', 'registeredAt', 'registeredBy']) {
    assert.equal(Object.hasOwn(next, key), false, key);
  }
  for (const containers of [[], [{ name: 'other' }], [{ name: 'site' }, { name: 'site' }]]) {
    assert.throws(() => createEcsTaskDefinition({ ...original, containerDefinitions: containers }, image), /exactly one.*site/);
  }
  assert.throws(() => createEcsTaskDefinition({ ...original, taskRoleArn: 'arn:aws:iam::123456789012:role/app' }, image), /taskRoleArn/);
  assert.throws(() => createEcsTaskDefinition({ ...original, runtimePlatform: { cpuArchitecture: 'ARM64' } }, image), /X86_64/);
  for (const unsafe of ['repo:latest', `${image};command`, image.replace(digest, 'sha256:abc')]) {
    assert.throws(() => createEcsTaskDefinition(original, unsafe), /digest/i);
  }
});

test('ECS readiness never treats a circuit-breaker rollback or mismatched PRIMARY as success', () => {
  assert.doesNotThrow(() => assertEcsDeploymentReady(ecsService(), nextTask));
  for (const state of [
    ecsService(previousTask), { ...ecsService(), taskDefinition: previousTask },
    { ...ecsService(), deployments: [{ status: 'PRIMARY', taskDefinition: previousTask, rolloutState: 'COMPLETED' }] },
    ...['FAILED', 'IN_PROGRESS', undefined].map((rolloutState) => ({ ...ecsService(), deployments: [{ ...ecsService().deployments[0], rolloutState }] })),
    { ...ecsService(), deployments: [] }, { ...ecsService(), runningCount: 0 }, { ...ecsService(), desiredCount: 0 },
  ]) assert.throws(() => assertEcsDeploymentReady(state, nextTask), /ECS|rollback/i);
});

test('Azure requires Single mode and the intended healthy ready revision and digest', () => {
  const { app, revision } = azureState();
  assert.equal(isAzureDeploymentReady(app, revision, revision.name, image), true);
  assert.throws(() => isAzureDeploymentReady(app, revision, undefined, image), /revision/i);
  assert.throws(() => isAzureDeploymentReady(app, revision, revision.name, 'repo:latest'), /digest/i);
  for (const change of [
    { latestReadyRevisionName: 'konda--old' }, { latestRevisionName: 'konda--other' },
    { provisioningState: 'Updating' }, { template: { containers: [{ image: 'old:tag' }] } },
  ]) assert.equal(isAzureDeploymentReady({ properties: { ...app.properties, ...change } }, revision, revision.name, image), false);
  assert.equal(isAzureDeploymentReady(app, { ...revision, properties: { ...revision.properties, active: false } }, revision.name, image), false);
  assert.equal(isAzureDeploymentReady(app, azureState('old:tag').revision, revision.name, image), false);
  assert.throws(() => isAzureDeploymentReady({ properties: { ...app.properties, provisioningState: 'Failed' } }, revision, revision.name, image), /failed/i);
  assert.throws(() => isAzureDeploymentReady({ properties: { ...app.properties, configuration: { activeRevisionsMode: 'Multiple' } } }, revision, revision.name, image), /Single/);
  assert.throws(() => isAzureDeploymentReady({ properties: { ...app.properties, template: { containers: [{}, {}] } } }, revision, revision.name, image), /one container/);
});

test('Cloud Run requires the observed ready revision, resolved digest, and 100 percent traffic', () => {
  const { service, revision } = gcpState();
  const name = revision.metadata.name;
  assert.equal(isGcpDeploymentReady(service, revision, name, image), true);
  assert.throws(() => isGcpDeploymentReady(service, revision, undefined, image), /revision/i);
  assert.throws(() => isGcpDeploymentReady(service, revision, name, 'repo:latest'), /digest/i);
  for (const status of [
    { observedGeneration: 1 }, { latestReadyRevisionName: 'konda-old' }, { latestCreatedRevisionName: 'konda-other' },
    { traffic: [{ revisionName: name, percent: 99 }] },
    { traffic: [{ revisionName: 'konda-old', percent: 100 }] },
    { traffic: [{ revisionName: name, percent: 90 }, { revisionName: 'konda-old', percent: 10 }] },
    { conditions: [{ type: 'Ready', status: 'Unknown' }] },
  ]) assert.equal(isGcpDeploymentReady({ ...service, status: { ...service.status, ...status } }, revision, name, image), false);
  assert.equal(isGcpDeploymentReady(service, { ...revision, status: { ...revision.status, imageDigest: imageId } }, name, image), false);
  assert.equal(isGcpDeploymentReady({ ...service, status: { ...service.status, traffic: [] } }, revision, name, image, { requireTraffic: false }), true);
  assert.throws(() => isGcpDeploymentReady({ ...service, status: { ...service.status, conditions: [{ type: 'Ready', status: 'False' }] } }, revision, name, image), /failed/i);
});

test('provider command contracts publish the tested image by digest and record rollback before updating', async (t) => {
  for (const cloud of Object.keys(providers)) for (const outcome of ['ready', 'not-ready']) await t.test(`${cloud}: ${outcome}`, async (t) => {
    const artifactDirectory = await temporaryDirectory(t);
    await writeFile(join(artifactDirectory, 'image-id.txt'), `${imageId}\n`);
    const config = validateDeploymentConfig(environment(cloud));
    const repository = {
      aws: image.split('@')[0], azure: 'konda12345.azurecr.io/konda-services',
      gcp: 'europe-west1-docker.pkg.dev/konda-project/konda-services/konda-services',
    }[cloud];
    const target = `${repository}@${digest}`;
    const calls = [];
    const summaries = [];
    let updated = false;
    const active = () => updated && outcome === 'ready';
    const run = async (command, args, options = {}) => {
      calls.push({ command, args, options });
      assert.equal(args.every((value) => typeof value === 'string'), true);
      if (command === 'docker') {
        if (args.includes('{{json .RepoDigests}}')) return JSON.stringify([target]);
        if (args[0] === 'image') return JSON.stringify({ Id: imageId, Os: 'linux', Architecture: 'amd64' });
        if (['login', 'tag', 'push'].includes(args[0])) return '';
      }
      if (command === 'aws') {
        if (args[0] === 'sts') return JSON.stringify({ Account: '123456789012' });
        if (args[1] === 'get-login-password') return 'temporary-password';
        if (args[1] === 'describe-services') return JSON.stringify({ services: [ecsService(active() ? nextTask : previousTask)] });
        if (args[1] === 'describe-task-definition') return JSON.stringify({ taskDefinition: taskDefinition() });
        if (args[1] === 'register-task-definition') {
          assert.equal(JSON.parse(args[args.indexOf('--cli-input-json') + 1]).containerDefinitions[0].image, target);
          return JSON.stringify({ taskDefinition: { taskDefinitionArn: nextTask } });
        }
        if (args[1] === 'update-service') {
          assert.match(summaries.join('\n'), /konda:1/);
          updated = true;
          return '{}';
        }
        if (args[1] === 'wait') return '';
      }
      if (command === 'az') {
        if (args[0] === 'acr') return args[1] === 'show' ? JSON.stringify({ loginServer: 'konda12345.azurecr.io' }) : '';
        if (args[1] === 'update') {
          assert.match(summaries.join('\n'), /konda--old/);
          updated = true;
          return JSON.stringify(azureState(target).app);
        }
        if (args[1] === 'show') return JSON.stringify(azureState(active() ? target : 'old:tag', active() ? 'konda--new' : 'konda--old').app);
        if (args[1] === 'revision') return JSON.stringify(azureState(updated ? target : 'old:tag', updated ? 'konda--new' : 'konda--old').revision);
      }
      if (command === 'gcloud') {
        if (args[0] === 'auth') return '';
        if (args[1] === 'revisions') return JSON.stringify(gcpState(updated ? target : image, updated ? 'konda-00002-abc' : 'konda-00001-abc').revision);
        if (args[2] === 'update') {
          assert.match(summaries.join('\n'), /konda-00001-abc/);
          assert.ok(args.includes('--no-traffic'));
          updated = true;
          return JSON.stringify(gcpState(target).service);
        }
        if (args[2] === 'update-traffic') {
          assert.ok(args.includes('--to-latest'));
          return JSON.stringify(gcpState(target).service);
        }
        if (args[2] === 'describe') return JSON.stringify(gcpState(active() ? target : image, active() ? 'konda-00002-abc' : 'konda-00001-abc').service);
      }
      assert.fail(`Unexpected command: ${command} ${args.join(' ')}`);
    };
    const deployment = deployContainer(config, { run, artifactDirectory, summarize: async (text) => summaries.push(text), attempts: 2, intervalMs: 0 });
    if (outcome === 'ready') {
      const result = await deployment;
      assert.equal(result.image, target);
      assert.equal(result.publicUrl, 'https://konda.com');
    } else {
      await assert.rejects(deployment, /rollback|bounded deployment wait/i);
      assert.equal(calls.some(({ args }) => args.includes('update-traffic')), false);
      assert.doesNotMatch(summaries.join('\n'), /rollout checks passed/);
    }
    assert.ok(calls.some(({ command, args }) => command === 'docker' && args[0] === 'push' && args[1] === `${repository}:${config.releaseTag}`));
    assert.equal(calls.some(({ args }) => args.includes('build') || args.includes('create') || args.includes('--allow-unauthenticated') || args.includes('--ingress')), false);
    const mutation = calls.find(({ args }) => args.includes('update-service') || args.includes('update'));
    assert.ok(mutation);
    assert.ok(mutation.args.includes(cloud === 'aws' ? nextTask : target));
    assert.match(summaries.join('\n'), /sha256:/);
  });
});

test('invalid deployment selections and tampered artifacts stop before any cloud commands', async (t) => {
  for (const cloud of ['unknown', '__proto__', 'toString']) {
    await assert.rejects(deployContainer({ cloud }, { run: () => assert.fail('No command should run') }), /unsupported.*cloud/i);
  }
  const artifactDirectory = await temporaryDirectory(t);
  await writeFile(join(artifactDirectory, 'image-id.txt'), `${imageId}\n`);
  const calls = [];
  await assert.rejects(deployContainer(validateDeploymentConfig(environment('aws')), {
    artifactDirectory,
    run: async (command, args) => { calls.push({ command, args }); return JSON.stringify({ Id: digest, Os: 'linux', Architecture: 'amd64' }); },
  }), /exact tested image/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'docker');
  assert.deepEqual(calls[0].args.slice(0, 2), ['image', 'inspect']);
});

async function verificationFixture(t) {
  const directory = await temporaryDirectory(t);
  const bodies = new Map();
  const escape = (value) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  const html = (route, title, heading = title) => `<!doctype html><html><head><title>${escape(title)}</title><link rel="canonical" href="${new URL(route, site.site.url).href}"></head><body><h1>${escape(heading)}</h1></body></html>`;
  bodies.set('/', Buffer.from(html('/', site.site.title)));
  for (const service of site.services.items) bodies.set(service.href, Buffer.from(html(service.href, `${service.title} | ${site.site.name}`, service.title)));
  bodies.set(site.routes.privacy, Buffer.from(html(site.routes.privacy, site.privacy.title)));
  bodies.set('/404.html', Buffer.from('<!doctype html><html><body>Not found</body></html>'));
  bodies.set('/theme.css', Buffer.from('body { color: #fff; }'));
  await mkdir(join(directory, '_astro'));
  bodies.set('/_astro/site.hash.css', Buffer.from('html { background: #000; }'));
  for (const [route, body] of bodies) await writeFile(join(directory, route === '/' ? 'index.html' : route.slice(1)), body);
  await writeFile(join(directory, '_headers'), 'not a public container asset');
  const state = { requests: [], statuses: new Map(), change: null };
  const server = createServer((request, response) => {
    state.requests.push(request.url);
    const route = request.url;
    response.once('finish', () => state.statuses.set(route, response.statusCode));
    const body = route === '/healthz' ? Buffer.from('ok\n') : bodies.get(route) || bodies.get('/404.html');
    response.statusCode = route === '/404.html' || (route !== '/healthz' && !bodies.has(route)) ? 404 : 200;
    for (const [name, value] of Object.entries(createSecurityHeaders(site))) response.setHeader(name, value);
    response.setHeader('Content-Type', route === '/healthz' ? 'text/plain' : route.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8');
    if (state.change?.(request, response, body)) return;
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { directory, state, url: `http://127.0.0.1:${server.address().port}` };
}

test('deployment verification checks real HTTP responses, all built bytes, canonical URLs, health and secure errors', async (t) => {
  const { directory, state, url } = await verificationFixture(t);
  const result = await verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 1 });
  assert.ok(result.checkedRoutes.includes('/healthz'));
  for (const route of ['/', ...site.services.items.map(({ href }) => href), site.routes.privacy, '/404.html', '/theme.css', '/_astro/site.hash.css']) {
    assert.ok(state.requests.includes(route), route);
  }
  assert.equal(state.statuses.get('/_headers'), 404);
  assert.equal(state.statuses.get('/site.config.json'), 404);
});

test('deployment verification rejects redirects, stale content, missing headers, wrong health and non-404 errors', async (t) => {
  const { directory, state, url } = await verificationFixture(t);
  for (const [name, change, expected] of [
    ['redirect', (request, response) => { if (request.url !== '/') return false; response.writeHead(302, { Location: '/theme.css' }).end(); return true; }, /status|redirect/i],
    ['stale content', (request, response) => { if (request.url !== '/') return false; response.end('old release'); return true; }, /bytes|content/i],
    ['missing security header', (request, response) => { if (request.url !== '/') return false; response.removeHeader('Content-Security-Policy'); return false; }, /Content-Security-Policy/i],
    ['wrong health', (request, response) => { if (request.url !== '/healthz') return false; response.end('not ready'); return true; }, /healthz/],
    ['soft 404', (request, response) => { if (!request.url.includes('deployment-probe-missing')) return false; response.statusCode = 200; return false; }, /404/],
    ['insecure error', (request, response) => { if (!request.url.includes('deployment-probe-missing')) return false; response.removeHeader('X-Frame-Options'); return false; }, /X-Frame-Options/i],
  ]) await t.test(name, async () => {
    state.change = change;
    await assert.rejects(verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 1 }), expected);
  });
});

test('deployment verification retries a transient failure but never permits local HTTP implicitly', async (t) => {
  const { directory, state, url } = await verificationFixture(t);
  let failures = 1;
  state.change = (request, response) => {
    if (request.url === '/healthz' && failures-- > 0) { response.statusCode = 503; response.end('starting'); return true; }
    return false;
  };
  await verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 2, intervalMs: 1 });
  assert.equal(state.requests.filter((route) => route === '/healthz').length, 2);
  await assert.rejects(verifyDeployment({ url, dist: directory, attempts: 1 }), /origin/i);
  await assert.rejects(verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 0 }), /attempts/);
});

test('deployment verification rejects a stale canonical configuration before probing a network endpoint', async (t) => {
  const { directory, state, url } = await verificationFixture(t);
  const home = await readFile(join(directory, 'index.html'), 'utf8');
  await writeFile(join(directory, 'index.html'), home.replace(new URL('/', site.site.url).href, 'https://wrong-domain.com/'));
  await assert.rejects(verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 1 }), /canonical/);
  assert.deepEqual(state.requests, []);
});

test('deployment verification bounds requests to an unresponsive endpoint', async (t) => {
  const { directory, state, url } = await verificationFixture(t);
  state.change = (request) => request.url === '/healthz';
  await assert.rejects(verifyDeployment({ url, dist: directory, allowLocal: true, attempts: 1, timeoutMs: 100 }), /timeout|timed out|abort/i);
  assert.equal(state.requests.filter((route) => route === '/healthz').length, 1);
});

test('the documented command-line entry points validate configuration and verify a loopback release', async (t) => {
  const executeFile = promisify(execFile);
  const { directory, url } = await verificationFixture(t);
  const env = { ...process.env, ...environment('aws'), GITHUB_STEP_SUMMARY: '' };
  const options = { env, timeout: 5000 };
  const validated = await executeFile(process.execPath, ['scripts/deploy-container.mjs', 'validate'], options);
  assert.match(validated.stdout, /Validated aws deployment configuration/);
  await assert.rejects(executeFile(process.execPath, ['scripts/deploy-container.mjs', 'validate'], { ...options, env: { ...env, GITHUB_REF: 'refs/heads/feature' } }), /only.*main/);
  const args = ['scripts/verify-deployment.mjs', '--url', url, '--dist', directory, '--attempts', '1'];
  const verified = await executeFile(process.execPath, [...args, '--allow-local'], options);
  assert.match(verified.stdout, /Public verification passed/);
  await assert.rejects(executeFile(process.execPath, args, options), /public HTTPS origin/);
});