#!/usr/bin/env node
'use strict';
// Runs the Azure DevOps integration cases on a real agent, in a real organization.
//
//   node tests/integration/azure-devops/live/run-live.js [--case <text>] [--print-yaml] [--keep]
//
// Settings come from the environment (README.md in the parent folder says how to get them):
//
//   DSCPR_AZDO_ORG        the organization: its name, or https://dev.azure.com/<name>
//   DSCPR_AZDO_PROJECT    a project in it; the test repository and pipeline are created there
//   DSCPR_AZDO_TOKEN      a personal access token (the scopes are listed in README.md)
//   DSCPR_AZDO_POOL       optional: an agent pool to run on. Without it, a Microsoft-hosted agent
//   DSCPR_AZDO_VM_IMAGE   optional: the Microsoft-hosted image (default ubuntu-latest)
//
// What it does, and removes again whatever happens:
//   1. uploads the task from this working tree to the organization under a test name and id, so
//      it cannot be confused with the published extension
//   2. creates a repository holding a generated azure-pipelines.yml and the test fixtures
//   3. creates a pipeline for it, with the cases' secret variables, and runs it
//   4. reads the run's timeline and logs, and checks every case
//
// --print-yaml only prints the pipeline it would run. --keep leaves everything in place.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TASK_NAME, buildPipelineYaml, collectVariables, evaluateCase } = require('./pipeline.js');

const repository = path.resolve(__dirname, '..', '..', '..', '..');
const casesDirectory = path.join(__dirname, '..', 'cases');
// Not the id of the published task.
const TASK_ID = 'c0a8f3d2-5b1e-4e6a-9f27-7d3b8e1a4c55';
const API = 'api-version=7.1';
const flag = (name) => process.argv.includes(`--${name}`);
const argument = (name) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };

function loadCases(only) {
  return fs.readdirSync(casesDirectory)
    .filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json')))
    .filter((name) => !only || name.includes(only))
    .sort()
    .map((name) => ({ name, definition: JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8')) }))
    .filter(({ definition }) => definition.live !== false);
}

function settings() {
  const missing = ['DSCPR_AZDO_ORG', 'DSCPR_AZDO_PROJECT', 'DSCPR_AZDO_TOKEN'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. See tests/integration/azure-devops/README.md.`);
    process.exit(2);
  }
  const organization = process.env.DSCPR_AZDO_ORG.replace(/\/+$/, '');
  return {
    collection: /^https?:\/\//.test(organization) ? organization : `https://dev.azure.com/${organization}`,
    project: process.env.DSCPR_AZDO_PROJECT,
    token: process.env.DSCPR_AZDO_TOKEN,
    pool: process.env.DSCPR_AZDO_POOL || '',
    vmImage: process.env.DSCPR_AZDO_VM_IMAGE || 'ubuntu-latest',
  };
}

function client({ collection, project, token }) {
  const authorization = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  async function call(method, url, body, accept = 'application/json') {
    const response = await fetch(url, {
      method,
      headers: { Authorization: authorization, Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const text = await response.text();
    // A token that is wrong or expired gets the sign-in page, not an error.
    if (response.status === 203 || response.status === 302 || response.status === 401) {
      throw new Error(`${method} ${url}: not signed in (HTTP ${response.status}). Check DSCPR_AZDO_TOKEN and its scopes.`);
    }
    if (!response.ok) throw new Error(`${method} ${url}: HTTP ${response.status} ${text.slice(0, 600)}`);
    if (accept !== 'application/json' || text === '') return text;
    return JSON.parse(text);
  }
  const projectUrl = `${collection}/${encodeURIComponent(project)}`;
  return { call, projectUrl, authorization };
}

function run(what, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${what} failed (exit code ${result.status}).\n${result.stdout || ''}${result.stderr || ''}`);
  return result.stdout;
}

// The task as it is in this working tree, renamed so it is plainly the test copy.
function stageTask(work, version) {
  const directory = path.join(work, 'task');
  fs.cpSync(path.join(repository, 'azure-devops', 'DscPipelineRunnerTask'), directory, { recursive: true });
  fs.mkdirSync(path.join(directory, 'core'), { recursive: true });
  for (const file of ['Invoke-DscPipelineRunnerStep.ps1', 'settings.json']) {
    fs.copyFileSync(path.join(repository, 'core', file), path.join(directory, 'core', file));
  }
  const taskPath = path.join(directory, 'task.json');
  const task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  task.id = TASK_ID;
  task.name = TASK_NAME;
  task.friendlyName = 'Dsc.PipelineRunner (integration test copy)';
  task.description = 'A copy of the Dsc.PipelineRunner task uploaded by its integration tests. Safe to delete.';
  task.version = version;
  fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  return directory;
}

// The repository the pipeline runs from: the generated pipeline and this repository's fixtures.
function stageRepository(work, yaml) {
  const directory = path.join(work, 'repository');
  fs.mkdirSync(path.join(directory, '_fixtures', 'tests'), { recursive: true });
  fs.cpSync(path.join(repository, 'tests', 'fixtures'), path.join(directory, '_fixtures', 'tests', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'azure-pipelines.yml'), yaml);
  const git = (...args) => run(`git ${args[0]}`, 'git', ['-C', directory, '-c', 'user.name=Integration tests', '-c', 'user.email=integration@example.test', '-c', 'commit.gpgsign=false', ...args]);
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'Dsc.PipelineRunner task integration test');
  return directory;
}

const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

async function main() {
  const cases = loadCases(argument('case'));
  if (cases.length === 0) { console.error('No case matches.'); process.exit(2); }

  if (flag('print-yaml')) {
    process.stdout.write(buildPipelineYaml(cases, { pool: process.env.DSCPR_AZDO_POOL || '', vmImage: process.env.DSCPR_AZDO_VM_IMAGE || 'ubuntu-latest' }));
    return 0;
  }

  const config = settings();
  const { call, projectUrl, authorization } = client(config);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-azdo-live-'));
  // A version no earlier run used, so the agent never runs a cached copy of an older upload.
  const stamp = Math.floor(Date.now() / 1000);
  const version = { Major: 0, Minor: Math.floor(stamp / 86400), Patch: stamp % 86400 };
  const name = `dscpr-integration-${stamp}`;
  const created = {};
  let failed = 0;

  try {
    console.log(`Organization ${config.collection}, project ${config.project}, ${config.pool ? `pool ${config.pool}` : `Microsoft-hosted ${config.vmImage}`}`);

    console.log(`Uploading the task as ${TASK_NAME} ${version.Major}.${version.Minor}.${version.Patch} ...`);
    const taskDirectory = stageTask(work, version);
    run('Uploading the task (tfx build tasks upload)', 'npx', ['--yes', 'tfx-cli@0', 'build', 'tasks', 'upload', '--task-path', taskDirectory,
      '--service-url', config.collection, '--auth-type', 'pat', '--token', config.token, '--overwrite', '--no-prompt', '--no-color']);
    created.task = true;

    console.log(`Creating repository ${name} ...`);
    const yaml = buildPipelineYaml(cases, { pool: config.pool, vmImage: config.vmImage, taskMajor: version.Major });
    const local = stageRepository(work, yaml);
    const remote = await call('POST', `${projectUrl}/_apis/git/repositories?${API}`, { name });
    created.repository = remote.id;
    run('Pushing the test repository', 'git', ['-C', local, '-c', `http.extraheader=Authorization: ${authorization}`, 'push', '-q', remote.remoteUrl, 'main']);

    console.log('Creating the pipeline ...');
    const pipeline = await call('POST', `${projectUrl}/_apis/pipelines?${API}`, {
      name, folder: '\\', configuration: { type: 'yaml', path: '/azure-pipelines.yml', repository: { id: remote.id, name, type: 'azureReposGit' } },
    });
    created.pipeline = pipeline.id;

    const secrets = collectVariables(cases, 'secretVariables');
    if (Object.keys(secrets).length > 0) {
      const definition = await call('GET', `${projectUrl}/_apis/build/definitions/${pipeline.id}?${API}`);
      definition.variables = { ...(definition.variables || {}) };
      for (const [variable, value] of Object.entries(secrets)) definition.variables[variable] = { value, isSecret: true };
      await call('PUT', `${projectUrl}/_apis/build/definitions/${pipeline.id}?${API}`, definition);
    }

    const build = await call('POST', `${projectUrl}/_apis/build/builds?${API}`, { definition: { id: pipeline.id }, sourceBranch: 'refs/heads/main' });
    console.log(`Run ${build.id} queued: ${build._links && build._links.web ? build._links.web.href : `${projectUrl}/_build/results?buildId=${build.id}`}`);

    const deadline = Date.now() + 45 * 60 * 1000;
    let state = build;
    while (state.status !== 'completed') {
      if (Date.now() > deadline) throw new Error(`Run ${build.id} did not finish in 45 minutes (status ${state.status}). A new pipeline may be waiting for permission to use the agent pool: open the run and permit it, or allow the pool for all pipelines.`);
      await sleep(15000);
      state = await call('GET', `${projectUrl}/_apis/build/builds/${build.id}?${API}`);
    }
    console.log(`Run ${build.id} finished: ${state.result}`);

    const timeline = await call('GET', `${projectUrl}/_apis/build/builds/${build.id}/timeline?${API}`);
    const records = timeline.records || [];
    const logCache = new Map();
    for (const record of records) {
      if (record.type === 'Task' && /^(case|verify) \d+$/.test(record.name) && record.log && record.log.url) {
        logCache.set(record.id, await call('GET', record.log.url, undefined, 'text/plain'));
      }
    }
    const logs = (record) => logCache.get(record.id) || '';

    if (!records.some((record) => record.type === 'Task' && /^case \d+$/.test(record.name))) {
      failed += 1;
      console.log('FAIL  the run did not reach the cases. What the run reported:');
      for (const record of records) {
        for (const issue of record.issues || []) console.log(`        [${record.type} ${record.name}] ${issue.type}: ${issue.message}`);
      }
    } else {
      cases.forEach(({ name: caseName, definition }, index) => {
        const failures = evaluateCase(definition, index, records, logs);
        if (failures.length === 0) { console.log(`ok    ${caseName}`); return; }
        failed += 1;
        console.log(`FAIL  ${caseName}  -  ${definition.description || ''}`);
        for (const failure of failures) console.log(`        ${failure}`);
        const record = records.find((candidate) => candidate.type === 'Task' && candidate.name === `case ${String(index + 1).padStart(2, '0')}`);
        if (record) for (const line of logs(record).split(/\r?\n/)) console.log(`        | ${line}`);
      });
    }
    console.log(`\n${cases.length} case(s), ${failed} failed.`);
  } finally {
    if (flag('keep')) {
      console.log(`--keep: left in place: pipeline ${created.pipeline}, repository ${created.repository}, task ${TASK_ID}.`);
    } else {
      const remove = async (what, action) => {
        try { await action(); } catch (error) { console.log(`Could not remove ${what}: ${error.message}`); }
      };
      if (created.pipeline) await remove('the pipeline', () => call('DELETE', `${projectUrl}/_apis/build/definitions/${created.pipeline}?${API}`));
      if (created.repository) await remove('the repository', () => call('DELETE', `${projectUrl}/_apis/git/repositories/${created.repository}?${API}`));
      if (created.task) await remove('the task', () => call('DELETE', `${config.collection}/_apis/distributedtask/tasks/${TASK_ID}?${API}`));
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
