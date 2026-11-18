#!/usr/bin/env node
'use strict';
// Runs the GitLab integration cases on a real GitLab server: GitLab CE and a GitLab Runner in
// Docker, a project holding this working tree, and a pipeline that includes the component from
// that project at the commit under test.
//
//   node tests/integration/gitlab/live/run-live.js [--case <text>] [--print-yaml] [--keep]
//
// What is real: GitLab (the component spec and its input checks, include merging, variable
// expansion, masked variables, the raw file endpoint the step script is fetched from, artifacts
// and the dotenv report), GitLab Runner with the Docker executor, the job image with PowerShell 7,
// and the step script. What is a stand-in: Dsc.PipelineRunner (tests/fixtures/modules).
//
// Needs Docker and about 15 minutes, most of it starting GitLab. Everything it creates is removed
// afterwards (--keep leaves the containers running). --print-yaml only prints the pipeline.
//
// Settings (all optional):
//   DSCPR_GITLAB_IMAGE          the GitLab image (default gitlab/gitlab-ce:latest)
//   DSCPR_GITLAB_RUNNER_IMAGE   the runner image (default gitlab/gitlab-runner:latest)
//   DSCPR_GITLAB_PORT           the host port GitLab is reached on (default 8929)

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isRefused, buildPipeline, buildRefusedPipeline, evaluateCase, evaluateRefusedCase, cleanTrace } = require('./pipeline.js');

const repository = path.resolve(__dirname, '..', '..', '..', '..');
const casesDirectory = path.join(__dirname, '..', 'cases');
const NETWORK = 'dscpr-gitlab-it';
const GITLAB = 'dscpr-gitlab-it-server';
const RUNNER = 'dscpr-gitlab-it-runner';
const HOSTNAME = 'gitlab';
const PROJECT = 'dsc-pipeline-runner-actions';
const API = 'api/v4';
const flag = (name) => process.argv.includes(`--${name}`);
const argument = (name) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined; };
const sleep = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); });

function loadCases(only) {
  return fs.readdirSync(casesDirectory)
    .filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json')))
    .filter((name) => !only || name.includes(only))
    .sort()
    .map((name) => ({ name, definition: JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8')) }))
    .filter(({ definition }) => definition.live !== false);
}

function run(what, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFailure) throw new Error(`${what} failed (exit code ${result.status}).\n${result.stdout || ''}${result.stderr || ''}`);
  return result;
}

const docker = (what, args, options) => run(what, 'docker', args, options);

async function api(base, token, method, route, body, accept = 'application/json') {
  const response = await fetch(`${base}/${API}/${route}`, {
    method,
    signal: AbortSignal.timeout(120000),
    headers: { 'PRIVATE-TOKEN': token, Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status} ${text.slice(0, 800)}`);
  if (accept !== 'application/json' || text === '') return text;
  return JSON.parse(text);
}

async function waitFor(what, check, timeoutMinutes, everySeconds = 10) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMinutes} minutes.`);
    await sleep(everySeconds * 1000);
  }
}

// This working tree as a git repository with the generated pipeline in it.
function stageRepository(work, yaml) {
  const directory = path.join(work, 'repository');
  fs.mkdirSync(directory, { recursive: true });
  for (const entry of fs.readdirSync(repository)) {
    if (['.git', 'node_modules', 'dist', 'dsc-reports'].includes(entry)) continue;
    fs.cpSync(path.join(repository, entry), path.join(directory, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(directory, '.gitlab-ci.yml'), yaml);
  const git = (...args) => run(`git ${args[0]}`, 'git', ['-C', directory, '-c', 'user.name=Integration tests', '-c', 'user.email=integration@example.test', '-c', 'commit.gpgsign=false', ...args]);
  git('init', '-q');
  git('checkout', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'The component under test');
  return { directory, sha: git('rev-parse', 'HEAD').stdout.trim() };
}

async function main() {
  const cases = loadCases(argument('case'));
  if (cases.length === 0) { console.error('No case matches.'); return 2; }
  const componentReference = `$CI_SERVER_FQDN/root/${PROJECT}/dsc-pipeline-runner`;
  const yaml = buildPipeline(cases, componentReference);
  if (flag('print-yaml')) { process.stdout.write(yaml); return 0; }

  const image = process.env.DSCPR_GITLAB_IMAGE || 'gitlab/gitlab-ce:latest';
  const runnerImage = process.env.DSCPR_GITLAB_RUNNER_IMAGE || 'gitlab/gitlab-runner:latest';
  const port = Number(process.env.DSCPR_GITLAB_PORT || 8929);
  const base = `http://127.0.0.1:${port}`;
  const password = `It-${crypto.randomBytes(12).toString('base64url')}`;
  const token = `glpat-${crypto.randomBytes(15).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 20)}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-gitlab-live-'));
  let failed = 0;
  const started = Date.now();
  const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;

  const cleanup = () => {
    for (const container of [RUNNER, GITLAB]) docker(`removing ${container}`, ['rm', '-f', container], { allowFailure: true });
    docker('removing the network', ['network', 'rm', NETWORK], { allowFailure: true });
  };

  try {
    docker('docker', ['version', '--format', '{{.Server.Version}}']);
    cleanup();
    docker('creating the network', ['network', 'create', NETWORK]);

    console.log(`Starting GitLab (${image}) ...`);
    const omnibus = [
      `external_url 'http://${HOSTNAME}'`,
      `gitlab_rails['initial_root_password'] = '${password}'`,
      "gitlab_rails['gitlab_shell_ssh_port'] = 22",
      "puma['worker_processes'] = 0",
      "sidekiq['concurrency'] = 5",
      "prometheus_monitoring['enable'] = false",
      "gitlab_kas['enable'] = false",
      "gitlab_rails['gitlab_kas_enabled'] = false",
      "registry['enable'] = false",
      "gitlab_pages['enable'] = false",
      "letsencrypt['enable'] = false",
      "gitlab_rails['usage_ping_enabled'] = false",
      "gitlab_rails['env'] = { 'GITLAB_LOG_LEVEL' => 'warn' }",
    ].join('; ');
    docker('starting GitLab', ['run', '-d', '--name', GITLAB, '--hostname', HOSTNAME, '--network', NETWORK, '-p', `127.0.0.1:${port}:80`,
      '--shm-size', '256m', '-e', `GITLAB_OMNIBUS_CONFIG=${omnibus}`, image]);
    await waitFor('GitLab becoming ready', async () => {
      try {
        const response = await fetch(`${base}/users/sign_in`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        return response.status === 200;
      } catch { return false; }
    }, 12, 15);
    console.log(`GitLab is answering after ${elapsed()}. Waiting for its first configuration to finish ...`);
    // The web front answers before the first-boot configuration is over; services (Sidekiq among
    // them, which moves pipelines along) are still being restarted until the container says so.
    await waitFor('the first configuration finishing', async () => {
      const logs = docker('GitLab logs', ['logs', GITLAB], { allowFailure: true });
      return /gitlab Reconfigured!/.test(`${logs.stdout}${logs.stderr}`);
    }, 10, 10);
    await waitFor('every GitLab service running', async () => {
      const status = docker('gitlab-ctl status', ['exec', GITLAB, 'gitlab-ctl', 'status'], { allowFailure: true });
      const lines = status.stdout.split('\n').filter((line) => line.trim() !== '');
      return lines.length > 0 && lines.every((line) => line.startsWith('run:')) && lines.some((line) => line.startsWith('run: sidekiq'));
    }, 5, 10);
    await waitFor('GitLab reporting itself ready', async () => {
      const readiness = docker('readiness', ['exec', GITLAB, 'curl', '-sf', 'http://localhost/-/readiness?all=1'], { allowFailure: true });
      return readiness.status === 0 && /"status":"ok"/.test(readiness.stdout);
    }, 5, 10);
    console.log(`GitLab is ready after ${elapsed()}. Creating an access token ...`);
    // A personal access token for root, with a value this process chose.
    const ruby = `u = User.find_by_username('root'); t = u.personal_access_tokens.create!(scopes: [:api], name: 'integration tests', expires_at: 1.day.from_now); t.set_token('${token}'); t.save!; puts 'token-ok'`;
    const rails = docker('creating the access token', ['exec', GITLAB, 'gitlab-rails', 'runner', ruby]);
    if (!rails.stdout.includes('token-ok')) throw new Error(`The access token was not created:\n${rails.stdout}${rails.stderr}`);
    const version = await api(base, token, 'GET', 'version');
    console.log(`GitLab ${version.version} (${elapsed()})`);

    console.log(`Creating project root/${PROJECT} and pushing this working tree ...`);
    const project = await api(base, token, 'POST', 'projects', { name: PROJECT, path: PROJECT, visibility: 'public', initialize_with_readme: false });
    const staged = stageRepository(work, yaml);
    const authorization = `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
    run('pushing the repository', 'git', ['-C', staged.directory, '-c', `http.extraheader=Authorization: ${authorization}`, 'push', '-q', `${base}/root/${PROJECT}.git`, 'main']);
    const masked = {};
    for (const { definition } of cases) Object.assign(masked, definition.maskedVariables || {});
    for (const [key, value] of Object.entries(masked)) {
      await api(base, token, 'POST', `projects/${project.id}/variables`, { key, value, masked: true, protected: false, raw: true });
    }

    console.log('Registering a runner ...');
    // The runner carries every tag a case asks for, so a tagged job finds it; untagged jobs too.
    const tags = [...new Set(cases.flatMap(({ definition }) => (definition.inputs && definition.inputs.runner_tags) || []))];
    const registration = await api(base, token, 'POST', 'user/runners', { runner_type: 'instance_type', run_untagged: true, tag_list: tags, description: 'integration tests' });
    docker('starting the runner', ['run', '-d', '--name', RUNNER, '--network', NETWORK, '-v', '/var/run/docker.sock:/var/run/docker.sock', runnerImage]);
    docker('registering the runner', ['exec', RUNNER, 'gitlab-runner', 'register', '--non-interactive', '--url', `http://${HOSTNAME}`, '--token', registration.token,
      '--executor', 'docker', '--docker-image', 'alpine:3.20', '--docker-network-mode', NETWORK, '--docker-pull-policy', 'if-not-present']);
    docker('letting the runner take four jobs at once', ['exec', RUNNER, 'sed', '-i', 's/^concurrent = .*/concurrent = 4/', '/etc/gitlab-runner/config.toml']);

    // The push created the pipeline; GitLab may refuse it outright (yaml_errors).
    const pipeline = await waitFor('the pipeline being created', async () => {
      const list = await api(base, token, 'GET', `projects/${project.id}/pipelines?sha=${staged.sha}`);
      return list[0];
    }, 3, 5);
    console.log(`Pipeline ${pipeline.id} created (${elapsed()}): ${base}/root/${PROJECT}/-/pipelines/${pipeline.id}`);
    const describePipeline = async () => {
      const state = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}`);
      const list = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}/jobs?per_page=100`);
      const runners = await api(base, token, 'GET', 'runners/all');
      console.log(`        pipeline ${pipeline.id}: ${state.status}${state.yaml_errors ? ` (yaml errors: ${state.yaml_errors})` : ''}`);
      for (const job of list) console.log(`        job ${job.name}: ${job.status}${job.failure_reason ? ` (${job.failure_reason})` : ''}`);
      for (const runner of runners) console.log(`        runner ${runner.id} (${runner.runner_type}): online ${runner.online}, status ${runner.status}, paused ${runner.paused}`);
      const runnerLogs = docker('runner logs', ['logs', '--tail', '30', RUNNER], { allowFailure: true });
      console.log(`        ---- last lines of the runner container ----\n${runnerLogs.stdout}${runnerLogs.stderr}`);
      return { state, jobs: list };
    };
    // A runner must take the first job within a few minutes; otherwise say why, instead of waiting.
    await waitFor('a runner taking a job', async () => {
      const list = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}/jobs?per_page=100`);
      const state = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}`);
      if (['success', 'failed', 'canceled', 'skipped'].includes(state.status)) return true;
      return list.some((job) => !['created', 'pending', 'waiting_for_resource', 'preparing'].includes(job.status));
    }, 5, 10).catch(async (error) => {
      console.log(`FAIL  ${error.message} Nothing ran:`);
      await describePipeline();
      throw new Error('no runner took a job of the pipeline');
    });
    // A pipeline whose jobs stop changing (a job pending for a runner that never comes) is given
    // five minutes, not twenty-five.
    let lastSnapshot = '';
    let lastChange = Date.now();
    const finished = await waitFor(`pipeline ${pipeline.id} finishing`, async () => {
      const state = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}`);
      if (['success', 'failed', 'canceled', 'skipped'].includes(state.status)) return state;
      const list = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}/jobs?per_page=100`);
      const snapshot = list.map((job) => `${job.name}=${job.status}`).sort().join(' ');
      if (snapshot !== lastSnapshot) { lastSnapshot = snapshot; lastChange = Date.now(); }
      else if (Date.now() - lastChange > 5 * 60 * 1000) throw new Error(`pipeline ${pipeline.id} has not moved for five minutes (${list.filter((job) => job.status === 'pending').map((job) => job.name).join(', ') || 'no job'} pending).`);
      return null;
    }, 25, 15).catch(async (error) => {
      console.log(`FAIL  ${error.message} Where it stands:`);
      await describePipeline();
      throw error;
    });
    console.log(`Pipeline ${pipeline.id} finished: ${finished.status} (${elapsed()})`);
    if (finished.yaml_errors) {
      failed += 1;
      console.log(`FAIL  GitLab refused the pipeline:\n        ${finished.yaml_errors}`);
    }

    const jobs = await api(base, token, 'GET', `projects/${project.id}/pipelines/${pipeline.id}/jobs?per_page=100`);
    const traceCache = new Map();
    for (const job of jobs) traceCache.set(job.id, await api(base, token, 'GET', `projects/${project.id}/jobs/${job.id}/trace`, undefined, 'text/plain'));
    const traces = (job) => traceCache.get(job.id) || '';

    for (let index = 0; index < cases.length; index += 1) {
      const { name, definition } = cases[index];
      let failures;
      if (isRefused(definition)) {
        const content = buildRefusedPipeline(definition, index, componentReference, staged.sha);
        let lint;
        try {
          lint = await api(base, token, 'POST', `projects/${project.id}/ci/lint`, { content, dry_run: true, ref: 'main' });
        } catch (error) {
          lint = { valid: false, errors: [error.message] };
        }
        failures = evaluateRefusedCase(definition, lint);
        if (failures.length === 0) { console.log(`ok    ${name}  (refused by GitLab)`); continue; }
      } else if (finished.yaml_errors) {
        failures = ['the pipeline was refused, so the case did not run'];
      } else {
        failures = evaluateCase(definition, index, jobs, traces);
        if (failures.length === 0) {
          const job = jobs.find((candidate) => candidate.name === `case-${String(index + 1).padStart(2, '0')}`);
          console.log(`ok    ${name}  (${job ? job.status : '?'})`);
          continue;
        }
      }
      failed += 1;
      console.log(`FAIL  ${name}  -  ${definition.description || ''}`);
      for (const failure of failures) console.log(`        ${failure}`);
      const job = jobs.find((candidate) => candidate.name === `case-${String(index + 1).padStart(2, '0')}`);
      if (job) for (const line of cleanTrace(traces(job)).split('\n')) console.log(`        | ${line}`);
    }
    console.log(`\n${cases.length} case(s), ${failed} failed (${elapsed()}).`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${error.message}`);
    const logs = docker('GitLab logs', ['logs', '--tail', '60', GITLAB], { allowFailure: true });
    if (logs.stdout || logs.stderr) console.log(`---- last lines of the GitLab container ----\n${logs.stdout}${logs.stderr}`);
  } finally {
    if (flag('keep')) console.log(`--keep: GitLab is at ${base} (root / ${password}); containers ${GITLAB} and ${RUNNER} on network ${NETWORK}.`);
    else cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

// A promise that never settles would end the process quietly with code 0; that is a failure.
let finished = false;
process.on('exit', (code) => {
  if (!finished) { console.error('FAIL  the script ended before it finished (an operation never completed).'); process.exitCode = 1; }
  else if (code === 0 && process.exitCode === undefined) process.exitCode = 0;
});
const keepAlive = setInterval(() => {}, 60 * 1000);
main().then((code) => { finished = true; process.exitCode = code; }, (error) => { finished = true; console.error(error.stack); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
