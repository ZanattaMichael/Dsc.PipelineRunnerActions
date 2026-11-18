#!/usr/bin/env node
'use strict';
// Runs the CircleCI integration cases through the CircleCI CLI: `circleci config validate`
// processes the configuration (the orb inlined from this working tree) on CircleCI's servers,
// and `circleci local execute` runs each case's job in Docker with the real build agent.
//
//   node tests/integration/circleci/live/run-local-execute.js [--case <text>] [--actions-ref <ref>] [--print-config] [--keep]
//
// What is real: CircleCI's processing of the configuration (orb inlining, parameter types and
// enums, << parameters >> substitution, `when`), the build agent, the executor image with
// PowerShell 7, the fetch of the step script from GitHub at --actions-ref, and the step script.
// What is a stand-in: Dsc.PipelineRunner (tests/fixtures/modules). What local execute cannot
// show: store_artifacts (it skips uploads) and contexts (secrets are passed with --env).
//
// Needs Docker, a 0.1.x circleci CLI on PATH (the 1.x line has no local execute), and a commit of this repository on GitHub to fetch
// core/ from (--actions-ref; by default HEAD, which must have been pushed). If the CLI needs a
// token to process the configuration, set CIRCLE_TOKEN; without one, this exits 3 and says so.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orbTools = require('../orb.js');
const { isRefused, jobName, buildConfig, buildRefusedConfig, evaluateCase, evaluateRefusedCase } = require('./config.js');

const repository = path.resolve(__dirname, '..', '..', '..', '..');
const casesDirectory = path.join(__dirname, '..', 'cases');
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

function circleci(args, options = {}) {
  // The update check is turned off through the environment: 'local execute' hands its flags on to
  // the build agent, which does not know --skip-update-check.
  const result = spawnSync('circleci', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options, env: { ...process.env, CIRCLECI_CLI_SKIP_UPDATE_CHECK: 'true', ...(options.env || {}) } });
  if (result.error) throw new Error(`Could not run the circleci CLI: ${result.error.message}. Install it from https://circleci.com/docs/local-cli/.`);
  return { output: `${result.stdout || ''}${result.stderr || ''}`, exitCode: result.status === null ? 1 : result.status };
}

// This working tree, as local execute will copy it into the container, with the configuration.
function stageProject(work, config) {
  const directory = path.join(work, 'project');
  fs.mkdirSync(path.join(directory, '.circleci'), { recursive: true });
  for (const entry of fs.readdirSync(repository)) {
    if (['.git', 'node_modules', 'dist', 'dsc-reports'].includes(entry)) continue;
    fs.cpSync(path.join(repository, entry), path.join(directory, entry), { recursive: true });
  }
  fs.writeFileSync(path.join(directory, '.circleci', 'config.yml'), config);
  // local execute wants a git repository to check out.
  const git = (...args) => spawnSync('git', ['-C', directory, '-c', 'user.name=Integration tests', '-c', 'user.email=integration@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'The orb under test');
  return directory;
}

function main() {
  const cases = loadCases(argument('case'));
  if (cases.length === 0) { console.error('No case matches.'); return 2; }
  let actionsRef = argument('actions-ref');
  if (!actionsRef) {
    actionsRef = (spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
    if (!actionsRef) { console.error('Could not find the current commit; pass --actions-ref.'); return 2; }
    console.log(`--actions-ref not given: using HEAD ${actionsRef}, which must have been pushed to GitHub.`);
  }
  const orb = orbTools.readOrb(path.join(repository, 'circleci', 'orb.yml'));
  const config = buildConfig(orb, cases, actionsRef);
  if (flag('print-config')) { process.stdout.write(config); return 0; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-circleci-live-'));
  let failed = 0;
  try {
    const project = stageProject(work, config);
    const configPath = path.join(project, '.circleci', 'config.yml');

    console.log('Validating the configuration with CircleCI ...');
    const validation = circleci(['config', 'validate', configPath], { cwd: project });
    if (validation.exitCode !== 0) {
      // The CLI's own message when it wants a token, not the word in a configuration it echoes back.
      if (!process.env.CIRCLE_TOKEN && /circleci setup|set a token|token is (required|missing|invalid)|requires a token|unauthori[sz]ed|HTTP 401/i.test(validation.output.replace(/^\s*•\s*\|.*$/gm, ''))) {
        console.log(`The CircleCI CLI needs a token to process the configuration and CIRCLE_TOKEN is not set:\n${validation.output}`);
        return 3;
      }
      console.log(`FAIL  CircleCI refused the configuration:\n${validation.output}`);
      return 1;
    }
    console.log('ok    the configuration, with the orb inlined, is one CircleCI accepts');

    for (let index = 0; index < cases.length; index += 1) {
      const { name, definition } = cases[index];
      let failures;
      let output = '';
      if (isRefused(definition)) {
        const refusedPath = path.join(work, `refused-${index}.yml`);
        fs.writeFileSync(refusedPath, buildRefusedConfig(orb, definition, index, actionsRef));
        const result = circleci(['config', 'validate', refusedPath], { cwd: project });
        failures = evaluateRefusedCase(definition, result.output, result.exitCode);
        output = result.output;
        if (failures.length === 0) { console.log(`ok    ${name}  (refused by CircleCI)`); continue; }
      } else {
        // The 0.1.x CLI takes the job name as its argument, not as --job.
        const args = ['local', 'execute', '--config', configPath];
        // The job container runs as root and the project is mounted from this user: git in the
        // checkout step refuses a repository owned by someone else unless it is marked safe.
        args.push('--env', 'GIT_CONFIG_COUNT=1', '--env', 'GIT_CONFIG_KEY_0=safe.directory', '--env', 'GIT_CONFIG_VALUE_0=*');
        for (const [variable, value] of Object.entries(definition.context || {})) args.push('--env', `${variable}=${value}`);
        args.push(jobName(index));
        const result = circleci(args, { cwd: project });
        if (/unknown command "local"/.test(result.output)) {
          console.log('FAIL  this CircleCI CLI has no "local execute" (removed in the 1.x line). Install a 0.1.x release, for example VERSION=0.1.31425 with the install script.');
          failed += 1;
          break;
        }
        failures = evaluateCase(definition, result.output, result.exitCode);
        output = result.output;
        if (failures.length === 0) { console.log(`ok    ${name}  (${result.exitCode === 0 ? 'success' : 'failed'})`); continue; }
      }
      failed += 1;
      console.log(`FAIL  ${name}  -  ${definition.description || ''}`);
      for (const failure of failures) console.log(`        ${failure}`);
      for (const line of output.split(/\r?\n/)) console.log(`        | ${line}`);
    }
    console.log(`\n${cases.length} case(s), ${failed} failed.`);
  } finally {
    if (flag('keep')) console.log(`--keep: the project is in ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
  }
  return failed ? 1 : 0;
}

process.exitCode = main();
