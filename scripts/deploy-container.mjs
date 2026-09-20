import { execFile } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const testedImage = 'konda-services:release';
const releaseDirectory = '.deploy/container-release';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const repositoryPattern = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const rolePattern = /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role\/[A-Za-z0-9+=,.@_/-]+$/;
const taskArnPattern = /^arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:task-definition\/[A-Za-z0-9_-]+:[1-9][0-9]*$/;
const ecsName = '[A-Za-z0-9][A-Za-z0-9_-]{0,254}';
const ecsArnPrefix = 'arn:(?:aws|aws-us-gov|aws-cn):ecs:[a-z0-9-]+:[0-9]{12}:';
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const providerVariables = {
  aws: {
    AWS_REGION: /^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*$/,
    AWS_ROLE_ARN: rolePattern,
    AWS_ECR_REPOSITORY: /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/,
    AWS_ECS_CLUSTER: new RegExp(`^(?:${ecsName}|${ecsArnPrefix}cluster/${ecsName})$`),
    AWS_ECS_SERVICE: new RegExp(`^(?:${ecsName}|${ecsArnPrefix}service/(?:${ecsName}/)?${ecsName})$`),
  },
  azure: {
    AZURE_CLIENT_ID: uuidPattern, AZURE_TENANT_ID: uuidPattern, AZURE_SUBSCRIPTION_ID: uuidPattern,
    AZURE_RESOURCE_GROUP: /^(?!.*\.$)[A-Za-z0-9_][A-Za-z0-9_.()-]{0,89}$/,
    AZURE_CONTAINER_APP: /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/,
    AZURE_ACR_NAME: /^[a-zA-Z0-9]{5,50}$/,
  },
  gcp: {
    GCP_PROJECT_ID: /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    GCP_REGION: /^[a-z]+(?:-[a-z]+)+[1-9][0-9]*$/,
    GCP_ARTIFACT_REPOSITORY: /^[a-z][a-z0-9_-]{0,62}$/,
    GCP_CLOUD_RUN_SERVICE: /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/,
    GCP_WORKLOAD_IDENTITY_PROVIDER: /^projects\/[1-9][0-9]*\/locations\/global\/workloadIdentityPools\/[a-z0-9][a-z0-9-]{2,30}[a-z0-9]\/providers\/[a-z0-9][a-z0-9-]{2,30}[a-z0-9]$/,
    GCP_DEPLOY_SERVICE_ACCOUNT: /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/,
  },
};

export function validateSelection(env) {
  if (!Object.hasOwn(providerVariables, env.DEPLOY_CLOUD)) throw new Error('DEPLOY_CLOUD must select a supported cloud: aws, azure, or gcp.');
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error('Container deployment is allowed only from refs/heads/main.');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('Container deployment requires a manual workflow_dispatch event.');
  return env.DEPLOY_CLOUD;
}

export function validatePublicOrigin(value, { allowLocal = false } = {}) {
  const invalid = () => new Error('CONTAINER_PUBLIC_URL must be a public HTTPS origin without a path, credentials, port, query, or fragment (loopback HTTP requires --allow-local).');
  if (typeof value !== 'string' || /[\s\\<>"'\u0000-\u001f\u007f]/.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (value !== url.origin && value !== `${url.origin}/`) throw invalid();
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (allowLocal && loopback && ['http:', 'https:'].includes(url.protocol)) return url.origin;
  if (url.protocol !== 'https:' || url.port || isIP(url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|lan|test|invalid)$/.test(url.hostname)) throw invalid();
  return url.origin;
}

export function validateDeploymentConfig(env) {
  const cloud = validateSelection(env);
  const required = ['CONTAINER_PUBLIC_URL', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', ...Object.keys(providerVariables[cloud])];
  const missing = required.filter((name) => typeof env[name] !== 'string' || !env[name].trim());
  if (missing.length) throw new Error(`Missing required deployment configuration: ${missing.join(', ')}`);
  const patterns = {
    GITHUB_SHA: /^[a-f0-9]{40}$/,
    GITHUB_RUN_ID: /^[1-9][0-9]{0,19}$/, GITHUB_RUN_ATTEMPT: /^[1-9][0-9]{0,9}$/,
    ...providerVariables[cloud],
  };
  for (const [name, pattern] of Object.entries(patterns)) {
    if (!pattern.test(env[name]) || /[\s\u0000-\u001f\u007f]/.test(env[name])) throw new Error(`Invalid ${name}; use the provider's resource name or identifier, not a URL, shell expression, or placeholder.`);
  }
  if (cloud === 'aws' && (env.AWS_ECR_REPOSITORY.length < 2 || env.AWS_ECR_REPOSITORY.length > 256)) throw new Error('Invalid AWS_ECR_REPOSITORY length.');
  if (cloud === 'aws') {
    const role = env.AWS_ROLE_ARN.split(':');
    for (const name of ['AWS_ECS_CLUSTER', 'AWS_ECS_SERVICE']) {
      if (!env[name].startsWith('arn:')) continue;
      const arn = env[name].split(':');
      if (arn[1] !== role[1] || arn[3] !== env.AWS_REGION || arn[4] !== role[4]) throw new Error(`Invalid ${name}: ARN must match the configured AWS partition, region, and role account.`);
    }
  }
  return {
    cloud, publicUrl: validatePublicOrigin(env.CONTAINER_PUBLIC_URL),
    releaseTag: `sha-${env.GITHUB_SHA}-run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    env: Object.fromEntries(Object.keys(providerVariables[cloud]).map((name) => [name, env[name]])),
  };
}

function assertDigestReference(image) {
  const parts = typeof image === 'string' ? image.split('@') : [];
  if (parts.length !== 2 || !repositoryPattern.test(parts[0]) || !digestPattern.test(parts[1])) throw new Error('Expected an immutable registry/repository@sha256 digest reference.');
  return image;
}

export function pushedImageReference(repository, repoDigests) {
  const matches = Array.isArray(repoDigests) ? repoDigests.filter((value) => typeof value === 'string' && value.startsWith(`${repository}@`)) : [];
  if (matches.length !== 1) throw new Error('The pushed image must have exactly one digest for the target repository.');
  return assertDigestReference(matches[0]);
}

export function assertTestedImage(metadata, expectedId) {
  if (!digestPattern.test(expectedId) || metadata?.Id !== expectedId) throw new Error('Loaded image does not match the exact tested image ID in the release artifact.');
  if (metadata.Os !== 'linux' || metadata.Architecture !== 'amd64') throw new Error('The tested image must target linux/amd64.');
}

function assertEcsTaskSupported(task) {
  if (!task || !Array.isArray(task.containerDefinitions) || task.containerDefinitions.filter(({ name }) => name === 'site').length !== 1) throw new Error('ECS task definition must contain exactly one container named site.');
  if (Object.hasOwn(task, 'taskRoleArn')) throw new Error('Existing ECS taskRoleArn is unsupported: this static site has no app task role and deployment may pass only its execution role.');
  if (!rolePattern.test(task.executionRoleArn) || !task.family) throw new Error('ECS task definition must retain its family and existing executionRoleArn.');
  if (task.networkMode !== 'awsvpc' || !task.requiresCompatibilities?.includes('FARGATE')) throw new Error('An existing standard ECS Fargate task definition with awsvpc networking is required.');
  if ((task.runtimePlatform?.cpuArchitecture && task.runtimePlatform.cpuArchitecture !== 'X86_64') ||
    (task.runtimePlatform?.operatingSystemFamily && task.runtimePlatform.operatingSystemFamily !== 'LINUX')) throw new Error('ECS must use X86_64 Linux to run the tested linux/amd64 image.');
}

export function createEcsTaskDefinition(task, image) {
  assertDigestReference(image);
  assertEcsTaskSupported(task);
  const fields = [
    'family', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes',
    'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'tags',
    'pidMode', 'ipcMode', 'proxyConfiguration', 'inferenceAccelerators',
    'ephemeralStorage', 'runtimePlatform', 'enableFaultInjection',
  ];
  const definition = structuredClone(Object.fromEntries(fields.filter((name) => Object.hasOwn(task, name)).map((name) => [name, task[name]])));
  definition.containerDefinitions.find(({ name }) => name === 'site').image = image;
  return definition;
}

export function assertEcsDeploymentReady(service, expectedTask) {
  if (!taskArnPattern.test(expectedTask)) throw new Error('ECS verification requires the intended task definition ARN.');
  const primary = service?.deployments?.filter(({ status }) => status === 'PRIMARY') || [];
  if (service?.status !== 'ACTIVE' || service.taskDefinition !== expectedTask || primary.length !== 1 ||
    primary[0].taskDefinition !== expectedTask || primary[0].rolloutState !== 'COMPLETED' ||
    !(service.desiredCount > 0) || service.runningCount !== service.desiredCount || service.pendingCount !== 0) {
    throw new Error('ECS did not complete the intended task definition rollout; a rollback, failed rollout, or revision mismatch must not pass verification.');
  }
}

function oneContainer(containers, provider) {
  if (!Array.isArray(containers) || containers.length !== 1) throw new Error(`${provider} must have exactly one container; refusing to change an ambiguous service.`);
  return containers[0];
}

function assertRevisionName(value, provider) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]+$/.test(value)) throw new Error(`${provider} did not return a valid revision name.`);
}

function azureContainer(app) {
  if (app?.properties?.configuration?.activeRevisionsMode !== 'Single') throw new Error('Azure Container Apps must use Single revision mode.');
  return oneContainer(app.properties.template?.containers, 'Azure Container Apps');
}

export function isAzureDeploymentReady(app, revision, expectedRevision, image) {
  assertRevisionName(expectedRevision, 'Azure');
  assertDigestReference(image);
  const container = azureContainer(app);
  const properties = app.properties;
  const ready = revision?.properties;
  if ([properties.provisioningState, ready?.provisioningState, ready?.runningState].some((state) => /^(?:failed|canceled|cancelled)$/i.test(state))) throw new Error('Azure Container Apps revision provisioning failed.');
  return properties.provisioningState === 'Succeeded' && properties.latestRevisionName === expectedRevision &&
    properties.latestReadyRevisionName === expectedRevision && container.image === image &&
    revision?.name === expectedRevision && ready.active === true && ready.provisioningState === 'Provisioned' &&
    ready.healthState === 'Healthy' && oneContainer(ready.template?.containers, 'Azure revision').image === image;
}

function gcpReady(resource) {
  if (!resource?.metadata || !resource.status || Number(resource.status.observedGeneration) !== Number(resource.metadata.generation)) return false;
  if (!Number.isSafeInteger(Number(resource.metadata.generation)) || Number(resource.metadata.generation) < 1) return false;
  const ready = resource.status.conditions?.find(({ type }) => type === 'Ready');
  if (ready?.status === 'False') throw new Error('Cloud Run revision reconciliation failed. Inspect the service conditions and the recorded rollback revisions.');
  return ready?.status === 'True';
}

export function isGcpDeploymentReady(service, revision, expectedRevision, image, { requireTraffic = true } = {}) {
  assertRevisionName(expectedRevision, 'Cloud Run');
  assertDigestReference(image);
  const container = oneContainer(service?.spec?.template?.spec?.containers, 'Cloud Run');
  if (!gcpReady(service) || !gcpReady(revision)) return false;
  const status = service.status;
  const resolved = revision.status.imageDigest;
  if (status.latestCreatedRevisionName !== expectedRevision || status.latestReadyRevisionName !== expectedRevision ||
    revision.metadata.name !== expectedRevision || container.image !== image ||
    oneContainer(revision.spec?.containers, 'Cloud Run revision').image !== image ||
    (resolved !== image && resolved !== image.split('@')[1])) return false;
  if (!requireTraffic) return true;
  const traffic = (status.traffic || []).filter(({ percent }) => percent > 0);
  return traffic.length > 0 && traffic.every(({ revisionName, percent }) => revisionName === expectedRevision && Number.isInteger(percent)) &&
    traffic.reduce((total, { percent }) => total + percent, 0) === 100;
}

function execute(command, args, { input, timeout = 120_000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = execFile(command, args, {
      encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off', CLOUDSDK_CORE_DISABLE_PROMPTS: '1', AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args[0]} failed: ${stderr.trim() || (error.killed ? 'command timed out' : error.code)}`));
      else resolveCommand(stdout.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function summarize(text) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  else console.log(text);
}

const inline = (value) => `\`${String(value).replace(/[`\r\n<>]/g, ' ')}\``;

async function verifyImageArtifact(run, directory) {
  const expectedId = (await readFile(join(directory, 'image-id.txt'), 'utf8')).trim();
  const metadata = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .}}', testedImage]));
  assertTestedImage(metadata, expectedId);
}

async function publishImage(repository, config, run) {
  const tag = `${repository}:${config.releaseTag}`;
  await run('docker', ['tag', testedImage, tag]);
  await run('docker', ['push', tag], { timeout: 600_000 });
  const digests = JSON.parse(await run('docker', ['image', 'inspect', '--format', '{{json .RepoDigests}}', tag]));
  return pushedImageReference(repository, digests);
}

async function waitFor(check, description, { attempts, intervalMs, pause }) {
  const started = Date.now();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    if (attempt === attempts - 1 || Date.now() - started >= 600_000) break;
    await pause(intervalMs);
  }
  throw new Error(`${description} did not become ready with the intended digest and revision within the bounded deployment wait.`);
}

async function deployAws(config, context) {
  const { run, summarize: summary } = context;
  const env = config.env;
  const aws = async (args, options) => JSON.parse(await run('aws', [...args, '--region', env.AWS_REGION, '--output', 'json', '--no-cli-pager'], options));
  const serviceArgs = ['--cluster', env.AWS_ECS_CLUSTER, '--services', env.AWS_ECS_SERVICE];
  const describe = async () => {
    const response = await aws(['ecs', 'describe-services', ...serviceArgs]);
    if (response.failures?.length || response.services?.length !== 1 || response.services[0].status !== 'ACTIVE') throw new Error('The configured ECS service does not exist or is not ACTIVE; bootstrap it before deploying.');
    return response.services[0];
  };
  const service = await describe();
  const fargate = service.launchType === 'FARGATE' || (service.capacityProviderStrategy?.length > 0 && service.capacityProviderStrategy.every(({ capacityProvider }) => ['FARGATE', 'FARGATE_SPOT'].includes(capacityProvider)));
  if (!fargate || (service.deploymentController?.type && service.deploymentController.type !== 'ECS') || !(service.desiredCount > 0)) throw new Error('An existing, enabled standard ECS Fargate service with the ECS deployment controller is required.');
  if (!taskArnPattern.test(service.taskDefinition)) throw new Error('ECS returned an invalid previous task definition ARN.');
  const { taskDefinition } = await aws(['ecs', 'describe-task-definition', '--task-definition', service.taskDefinition]);
  assertEcsTaskSupported(taskDefinition);
  await summary(`### AWS container deployment\n\n- Public verification origin: ${inline(config.publicUrl)}\n- Previous task definition (manual rollback): ${inline(service.taskDefinition)}`);
  const { Account: account } = await aws(['sts', 'get-caller-identity']);
  if (!/^[0-9]{12}$/.test(account) || account !== env.AWS_ROLE_ARN.split(':')[4]) throw new Error('AWS caller account does not match AWS_ROLE_ARN.');
  const registry = `${account}.dkr.ecr.${env.AWS_REGION}.amazonaws.com${env.AWS_REGION.startsWith('cn-') ? '.cn' : ''}`;
  const password = await run('aws', ['ecr', 'get-login-password', '--region', env.AWS_REGION, '--no-cli-pager']);
  if (!password) throw new Error('ECR did not return a registry login token.');
  await run('docker', ['login', '--username', 'AWS', '--password-stdin', registry], { input: `${password}\n` });
  const image = await publishImage(`${registry}/${env.AWS_ECR_REPOSITORY}`, config, run);
  await summary(`- Published tested image: ${inline(image)}`);
  const registered = await aws(['ecs', 'register-task-definition', '--cli-input-json', JSON.stringify(createEcsTaskDefinition(taskDefinition, image))]);
  const nextTask = registered.taskDefinition?.taskDefinitionArn;
  if (!taskArnPattern.test(nextTask)) throw new Error('ECS did not return the newly registered task definition ARN.');
  await summary(`- Intended task definition: ${inline(nextTask)}`);
  await aws(['ecs', 'update-service', '--cluster', env.AWS_ECS_CLUSTER, '--service', env.AWS_ECS_SERVICE, '--task-definition', nextTask]);
  await run('aws', ['ecs', 'wait', 'services-stable', ...serviceArgs, '--region', env.AWS_REGION, '--no-cli-pager'], { timeout: 660_000 });
  assertEcsDeploymentReady(await describe(), nextTask);
  return { image, revision: nextTask };
}

async function deployAzure(config, context) {
  const { run, summarize: summary } = context;
  const env = config.env;
  const az = async (args, options) => JSON.parse(await run('az', [...args, '--only-show-errors', '--output', 'json'], options));
  const appArgs = ['--name', env.AZURE_CONTAINER_APP, '--resource-group', env.AZURE_RESOURCE_GROUP];
  const describe = () => az(['containerapp', 'show', ...appArgs]);
  const describeRevision = (revision) => az(['containerapp', 'revision', 'show', ...appArgs, '--revision', revision]);
  const app = await describe();
  azureContainer(app);
  const previousRevision = app.properties.latestReadyRevisionName;
  assertRevisionName(previousRevision, 'Azure previous ready revision');
  const previous = await describeRevision(previousRevision);
  const previousImage = oneContainer(previous.properties?.template?.containers, 'Azure revision').image;
  await summary(`### Azure container deployment\n\n- Public verification origin: ${inline(config.publicUrl)}\n- Previous ready revision (manual rollback): ${inline(previousRevision)}\n- Previous image: ${inline(previousImage)}`);
  const { loginServer } = await az(['acr', 'show', '--name', env.AZURE_ACR_NAME]);
  if (!/^[a-z0-9][a-z0-9-]*\.azurecr\.io$/.test(loginServer)) throw new Error('ACR did not return a valid Azure registry login server.');
  await run('az', ['acr', 'login', '--name', env.AZURE_ACR_NAME, '--only-show-errors']);
  const image = await publishImage(`${loginServer}/konda-services`, config, run);
  await summary(`- Published tested image: ${inline(image)}`);
  const updated = await az(['containerapp', 'update', ...appArgs, '--image', image], { timeout: 600_000 });
  const revision = updated.properties?.latestRevisionName;
  assertRevisionName(revision, 'Azure');
  await summary(`- Intended revision: ${inline(revision)}`);
  await waitFor(async () => isAzureDeploymentReady(await describe(), await describeRevision(revision), revision, image), 'Azure Container Apps', context);
  return { image, revision };
}

async function deployGcp(config, context) {
  const { run, summarize: summary } = context;
  const env = config.env;
  const locationArgs = ['--project', env.GCP_PROJECT_ID, '--region', env.GCP_REGION];
  const gcloud = async (args, options) => JSON.parse(await run('gcloud', [...args, '--quiet', '--format=json'], options));
  const describe = () => gcloud(['run', 'services', 'describe', env.GCP_CLOUD_RUN_SERVICE, ...locationArgs]);
  const describeRevision = (revision) => gcloud(['run', 'revisions', 'describe', revision, ...locationArgs]);
  const service = await describe();
  oneContainer(service.spec?.template?.spec?.containers, 'Cloud Run');
  const previousTraffic = (service.status?.traffic || []).filter(({ percent }) => percent > 0);
  if (!previousTraffic.length || previousTraffic.some(({ revisionName, percent }) => typeof revisionName !== 'string' || !/^[a-z][a-z0-9-]+$/.test(revisionName) || !Number.isInteger(percent)) || previousTraffic.reduce((sum, { percent }) => sum + percent, 0) !== 100) throw new Error('Cloud Run must have existing serving revisions to record a complete rollback traffic configuration.');
  await summary(`### GCP container deployment\n\n- Public verification origin: ${inline(config.publicUrl)}\n- Previous traffic (manual rollback): ${inline(previousTraffic.map(({ revisionName, percent }) => `${revisionName}=${percent}`).join(','))}`);
  for (const { revisionName } of previousTraffic) {
    const previous = await describeRevision(revisionName);
    if (!previous.status?.imageDigest) throw new Error('Cloud Run did not return the previous revision digest.');
    await summary(`- Previous image for ${inline(revisionName)}: ${inline(previous.status.imageDigest)}`);
  }
  const registry = `${env.GCP_REGION}-docker.pkg.dev`;
  await run('gcloud', ['auth', 'configure-docker', registry, '--quiet']);
  const image = await publishImage(`${registry}/${env.GCP_PROJECT_ID}/${env.GCP_ARTIFACT_REPOSITORY}/konda-services`, config, run);
  await summary(`- Published tested image: ${inline(image)}`);
  const updated = await gcloud(['run', 'services', 'update', env.GCP_CLOUD_RUN_SERVICE, ...locationArgs, '--image', image, '--no-traffic'], { timeout: 600_000 });
  const revision = updated.status?.latestCreatedRevisionName;
  assertRevisionName(revision, 'Cloud Run');
  await summary(`- Intended revision: ${inline(revision)}`);
  const ready = async (requireTraffic) => isGcpDeploymentReady(await describe(), await describeRevision(revision), revision, image, { requireTraffic });
  await waitFor(() => ready(false), 'Cloud Run revision', context);
  await gcloud(['run', 'services', 'update-traffic', env.GCP_CLOUD_RUN_SERVICE, ...locationArgs, '--to-latest'], { timeout: 600_000 });
  await waitFor(() => ready(true), 'Cloud Run 100% traffic rollout', context);
  return { image, revision };
}

export async function deployContainer(config, { run = execute, artifactDirectory = releaseDirectory, summarize: summary = summarize, attempts = 60, intervalMs = 10_000, pause = delay } = {}) {
  const deployments = { aws: deployAws, azure: deployAzure, gcp: deployGcp };
  if (!Object.hasOwn(deployments, config.cloud)) throw new Error('Unsupported deployment cloud.');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 30_000) throw new Error('Invalid deployment wait bounds.');
  await verifyImageArtifact(run, artifactDirectory);
  const result = await deployments[config.cloud](config, { run, summarize: summary, attempts, intervalMs, pause });
  await summary('- Provider rollout checks passed. Public content and security-header verification must also pass.');
  return { ...result, publicUrl: config.publicUrl };
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (command === '--help') {
    console.log('Usage: node scripts/deploy-container.mjs validate-selection|validate|verify-image|deploy\nUses DEPLOY_CLOUD, the GitHub workflow_dispatch/main context, CONTAINER_PUBLIC_URL, and the selected provider environment variables.');
    return;
  }
  if (extra.length || !['validate-selection', 'validate', 'verify-image', 'deploy'].includes(command)) throw new Error('Expected exactly one command: validate-selection, validate, verify-image, or deploy.');
  if (command === 'validate-selection') { validateSelection(process.env); return; }
  const config = validateDeploymentConfig(process.env);
  if (command === 'validate') { console.log(`Validated ${config.cloud} deployment configuration for ${config.publicUrl}.`); return; }
  if (command === 'verify-image') { await verifyImageArtifact(execute, releaseDirectory); return; }
  const result = await deployContainer(config);
  console.log(`Deployed ${result.image} as ${result.revision}; verify ${result.publicUrl} before declaring success.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}