#!/usr/bin/env node
'use strict';
// Runs the CircleCI integration cases against the orb in this working tree.
//
//   node tests/integration/circleci/run-cases.js [--case <text>] [--shell bash|pwsh] [--actions-ref <ref>]
//
// For each case in cases/, the orb's `run` command is expanded with the case's parameters the way
// CircleCI expands it (orb.js), and its steps are run the way the build agent runs them
// (agent.js). The command fetches the step script from GitHub at the orb's actions-ref, so what
// is tested is core/ as it is at --actions-ref: the commit under test in CI, and by default the
// current HEAD, which must have been pushed. A case is a folder with a case.json:
//
//   description       what the case shows
//   workspace         { "<folder in the working directory>": "<path in this repository>" } to copy in
//   parameters        the command's parameters, as in a config
//   environment       the job's environment (what `environment:` on the job would set)
//   context           environment variables from a context: secrets, masked in the log
//   hidePowerShell    true to run the job with a PATH that has no pwsh
//   expect.status     success or failed
//   expect.exitCode   the exit code of the command's run step
//   expect.parameterProblems   regular expressions the processing errors must match (nothing is then run)
//   expect.outputs    variables the outputs.env file must set (a value may be {"matches": "<regex>"})
//   expect.artifacts  paths the store_artifacts steps must have stored
//   expect.contains / notContains   regular expressions for the log (unmasked)
//   expect.call       values the stand-in Dsc.PipelineRunner must have been called with ("A.B" for nested;
//                     a value may be {"matches": "<regex>"})
//   expect.notCalled  true when the module must not have been called at all
//
// In values, {repo} is this repository, {workdir} the working directory and {pathsep} the PATH
// separator.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orbTools = require('./orb.js');
const agent = require('./agent.js');

const repository = path.resolve(__dirname, '..', '..', '..');
const casesDirectory = path.join(__dirname, 'cases');
const orbPath = path.join(repository, 'circleci', 'orb.yml');

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

function substitute(value, workdir) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('{repo}', repository).replaceAll('{workdir}', workdir).replaceAll('{pathsep}', path.delimiter);
}

function substituteDeep(node, workdir) {
  if (typeof node === 'string') return substitute(node, workdir);
  if (Array.isArray(node)) return node.map((item) => substituteDeep(item, workdir));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteDeep(value, workdir)]));
  return node;
}

function lookup(object, dotted) {
  return dotted.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), object);
}

function matchValue(actual, wanted) {
  if (wanted !== null && typeof wanted === 'object' && wanted.matches) return new RegExp(wanted.matches).test(String(actual));
  return JSON.stringify(actual) === JSON.stringify(wanted);
}

function describeWanted(wanted) {
  return wanted !== null && typeof wanted === 'object' && wanted.matches ? `to match /${wanted.matches}/` : JSON.stringify(wanted);
}

function parseOutputs(file) {
  if (!fs.existsSync(file)) return undefined;
  const outputs = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

function checkOutcome(definition, outcome, workdir) {
  const expect = definition.expect || {};
  const failures = [];
  if (outcome.stage === 'processing') {
    if (!expect.parameterProblems) return [`CircleCI refused the parameters: ${outcome.error}`];
    for (const pattern of expect.parameterProblems) if (!new RegExp(pattern).test(outcome.error)) failures.push(`the processing errors do not match /${pattern}/: ${outcome.error}`);
    return failures;
  }
  if (expect.parameterProblems) failures.push('CircleCI accepted the parameters, and must not have');

  const { result } = outcome;
  if (expect.status && result.status !== expect.status) failures.push(`status is ${result.status}, expected ${expect.status}`);
  const runStep = result.steps.find((step) => step.type === 'run');
  if (expect.exitCode !== undefined && (!runStep || runStep.exitCode !== expect.exitCode)) failures.push(`the run step's exit code is ${runStep ? runStep.exitCode : 'none'}, expected ${expect.exitCode}`);
  const reportPath = (definition.parameters || {})['report-path'] || 'dsc-reports';
  const outputs = parseOutputs(path.join(workdir, reportPath, 'outputs.env'));
  for (const [name, wanted] of Object.entries(expect.outputs || {})) {
    if (!outputs || !(name in outputs)) failures.push(`outputs.env does not set ${name}${outputs ? '' : ' (there is no outputs.env)'}`);
    else if (!matchValue(outputs[name], typeof wanted === 'string' ? substitute(wanted, workdir) : wanted)) failures.push(`output ${name} is '${outputs[name]}', expected ${describeWanted(wanted)}`);
  }
  for (const artifact of expect.artifacts || []) {
    const stored = result.steps.filter((step) => step.type === 'store_artifacts' && step.ran && step.path === artifact);
    if (stored.length === 0) failures.push(`no store_artifacts step ran for '${artifact}'`);
    else if (!stored[0].exists) failures.push(`store_artifacts ran for '${artifact}', but the path does not exist`);
  }
  for (const pattern of expect.contains || []) if (!new RegExp(pattern).test(result.raw)) failures.push(`the log does not match /${pattern}/`);
  for (const pattern of expect.notContains || []) if (new RegExp(pattern).test(result.raw)) failures.push(`the log matches /${pattern}/, which it must not`);

  const callFile = path.join(workdir, 'call.json');
  const called = fs.existsSync(callFile);
  if (expect.notCalled && called) failures.push('Dsc.PipelineRunner was called, and must not have been');
  if (expect.call) {
    if (!called) failures.push('Dsc.PipelineRunner was not called');
    else {
      const call = JSON.parse(fs.readFileSync(callFile, 'utf8'));
      for (const [key, wanted] of Object.entries(expect.call)) {
        if (!matchValue(lookup(call, key), wanted)) failures.push(`the module was called with ${key} = ${JSON.stringify(lookup(call, key))}, expected ${describeWanted(wanted)}`);
      }
    }
  }
  return failures;
}

function runCase(name, orb, root, actionsRef, shell) {
  const definition = JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8'));
  const workdir = path.join(root, name, 'project');
  fs.mkdirSync(workdir, { recursive: true });
  for (const [target, source] of Object.entries(definition.workspace || {})) fs.cpSync(path.join(repository, source), path.join(workdir, target), { recursive: true });

  const parameters = { 'actions-ref': actionsRef, ...substituteDeep(definition.parameters || {}, workdir) };
  let expanded;
  try {
    expanded = orbTools.expandCommand(orb, 'run', parameters);
  } catch (error) {
    return { definition, outcome: { stage: 'processing', error: error.message }, workdir };
  }

  const machine = { ...process.env };
  for (const variable of Object.keys(machine)) {
    // Nothing of the CI system this runs under may leak into the job.
    if (/^(GITHUB_|RUNNER_|INPUT_|DSCPR_|CI_)/.test(variable) || variable === 'CI') delete machine[variable];
  }
  if (definition.hidePowerShell) {
    const empty = path.join(root, name, 'empty-path');
    fs.mkdirSync(empty, { recursive: true });
    machine.PATH = empty;
    delete machine.Path;
  }
  const environment = { ...substituteDeep(definition.environment || {}, workdir), DSCPR_TEST_CALL_FILE: path.join(workdir, 'call.json') };
  const result = agent.runSteps({
    steps: expanded.steps, workingDirectory: workdir, jobName: name,
    environment, context: substituteDeep(definition.context || {}, workdir), machine, shell,
  });
  return { definition, outcome: { stage: 'run', result }, workdir };
}

function main() {
  const only = argument('case');
  const shell = argument('shell');
  let actionsRef = argument('actions-ref');
  if (!actionsRef) {
    const head = spawnSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    actionsRef = (head.stdout || '').trim();
    if (!actionsRef) { console.error('Could not find the current commit; pass --actions-ref.'); process.exit(2); }
    console.log(`--actions-ref not given: using HEAD ${actionsRef}, which must have been pushed to GitHub.`);
  }
  const orb = orbTools.readOrb(orbPath);
  let failed = 0;

  const orbProblems = orbTools.checkOrb(orb);
  if (orbProblems.length > 0) {
    failed += 1;
    console.log('FAIL  the orb');
    for (const problem of orbProblems) console.log(`        ${problem}`);
  } else {
    console.log(`ok    the orb declares ${Object.keys(orb.commands.run.parameters).length} parameters that CircleCI accepts`);
  }

  const names = fs.readdirSync(casesDirectory).filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json'))).sort();
  const selected = names.filter((name) => !only || name.includes(only));
  if (selected.length === 0) { console.error('No case matches.'); process.exit(2); }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-circleci-'));
  console.log(`Step script fetched from GitHub at ${actionsRef}; job shell ${shell || (process.platform === 'win32' ? 'pwsh' : 'bash')}`);
  for (const name of selected) {
    let outcome;
    try {
      outcome = runCase(name, orb, root, actionsRef, shell);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}\n        ${error.stack}`);
      continue;
    }
    const failures = checkOutcome(outcome.definition, outcome.outcome, outcome.workdir);
    const summary = outcome.outcome.stage === 'run' ? outcome.outcome.result.status : 'refused at processing';
    if (failures.length === 0) { console.log(`ok    ${name}  (${summary})`); continue; }
    failed += 1;
    console.log(`FAIL  ${name}  -  ${outcome.definition.description || ''}`);
    for (const failure of failures) console.log(`        ${failure}`);
    if (outcome.outcome.stage === 'run') {
      console.log('        ---- job log (secrets masked, as in CircleCI) ----');
      for (const line of outcome.outcome.result.log.split(/\r?\n/)) console.log(`        | ${line}`);
    }
  }
  if (!process.env.DSCPR_KEEP_WORK) fs.rmSync(root, { recursive: true, force: true });
  console.log(failed ? `\n${failed} of ${selected.length + 1} check(s) failed (the orb, and ${selected.length} case(s)).` : `\nThe orb and all ${selected.length} case(s) passed.`);
  process.exit(failed ? 1 : 0);
}

main();
