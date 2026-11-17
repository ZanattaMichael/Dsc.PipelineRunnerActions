#!/usr/bin/env node
'use strict';
// Runs the Azure DevOps integration cases against a packaged extension.
//
//   node tests/integration/azure-devops/run-cases.js --vsix dist/<file>.vsix [--case <text>]
//
// The task is taken out of the .vsix (so what is tested is what would be published) and each case
// in cases/ is run as one pipeline step by agent.js. A case is a folder with a case.json:
//
//   description       what the case shows
//   workspace         { "<folder in the sources directory>": "<path in this repository>" } to copy in
//   inputs            the step's inputs, as in a pipeline
//   variables         pipeline variables
//   secretVariables   secret pipeline variables
//   environment       extra environment of the agent machine
//   hidePowerShell    true to run the step with a PATH that has no pwsh
//   expect.result     Succeeded, SucceededWithIssues or Failed
//   expect.exitCode   the exit code of the task process
//   expect.outputs    output variables and their values (a value may be {"matches": "<regex>"})
//   expect.issues     [{ "type": "error", "matches": "<regex>" }] that must have been logged
//   expect.contains / notContains   regular expressions for the log (what the task wrote, unmasked)
//   expect.call       values the stand-in Dsc.PipelineRunner must have been called with ("A.B" for nested;
//                     a value may be {"matches": "<regex>"})
//   expect.notCalled  true when the module must not have been called at all
//   expect.files      files that must exist in the sources directory afterwards
//
// In values, {repo} is this repository, {workspace} the sources directory, {pathsep} the PATH
// separator and {env:NAME} a variable of this process.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('./agent.js');

const repository = path.resolve(__dirname, '..', '..', '..');
const casesDirectory = path.join(__dirname, 'cases');

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

function substitute(value, workspace) {
  if (typeof value !== 'string') return value;
  return value
    .replaceAll('{repo}', repository)
    .replaceAll('{workspace}', workspace)
    .replaceAll('{pathsep}', path.delimiter)
    .replace(/\{env:([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] || '');
}

function substituteAll(map, workspace) {
  return Object.fromEntries(Object.entries(map || {}).map(([name, value]) => [name, substitute(value, workspace)]));
}

function lookup(object, dotted) {
  return dotted.split('.').reduce((value, key) => (value === undefined || value === null ? undefined : value[key]), object);
}

function checkCase(definition, step, workspace) {
  const failures = [];
  const expect = definition.expect || {};
  if (expect.result && step.result !== expect.result) failures.push(`result is ${step.result}, expected ${expect.result}`);
  if (expect.exitCode !== undefined && step.exitCode !== expect.exitCode) failures.push(`exit code is ${step.exitCode}, expected ${expect.exitCode}`);

  for (const [name, wanted] of Object.entries(expect.outputs || {})) {
    const actual = step.outputs[name];
    if (actual === undefined) failures.push(`output variable '${name}' was not set`);
    else if (wanted !== null && typeof wanted === 'object') {
      if (!new RegExp(wanted.matches).test(actual)) failures.push(`output '${name}' is '${actual}', expected to match /${wanted.matches}/`);
    } else if (actual !== String(substitute(wanted, workspace))) failures.push(`output '${name}' is '${actual}', expected '${wanted}'`);
  }
  for (const issue of expect.issues || []) {
    const found = step.issues.some((logged) => logged.type === issue.type && new RegExp(issue.matches).test(logged.message));
    if (!found) failures.push(`no ${issue.type} issue matching /${issue.matches}/ was logged`);
  }
  for (const pattern of expect.contains || []) {
    if (!new RegExp(pattern).test(step.raw)) failures.push(`the log does not match /${pattern}/`);
  }
  for (const pattern of expect.notContains || []) {
    if (new RegExp(pattern).test(step.raw)) failures.push(`the log matches /${pattern}/, which it must not`);
  }

  const callFile = path.join(workspace, 'call.json');
  if (expect.notCalled && fs.existsSync(callFile)) failures.push('Dsc.PipelineRunner was called, and must not have been');
  if (expect.call) {
    if (!fs.existsSync(callFile)) failures.push('Dsc.PipelineRunner was not called');
    else {
      const call = JSON.parse(fs.readFileSync(callFile, 'utf8'));
      for (const [key, wanted] of Object.entries(expect.call)) {
        const actual = lookup(call, key);
        if (wanted !== null && typeof wanted === 'object' && wanted.matches) {
          if (!new RegExp(wanted.matches).test(String(actual))) failures.push(`the module was called with ${key} = ${JSON.stringify(actual)}, expected to match /${wanted.matches}/`);
        } else if (JSON.stringify(actual) !== JSON.stringify(wanted)) failures.push(`the module was called with ${key} = ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`);
      }
    }
  }
  for (const file of expect.files || []) {
    if (!fs.existsSync(path.join(workspace, file))) failures.push(`${file} does not exist in the sources directory`);
  }
  return failures;
}

function runCase(name, taskDirectory, root) {
  const definition = JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8'));
  const workspace = path.join(root, name, 's');
  fs.mkdirSync(workspace, { recursive: true });
  for (const [target, source] of Object.entries(definition.workspace || {})) {
    fs.cpSync(path.join(repository, source), path.join(workspace, target), { recursive: true });
  }

  const environment = { ...process.env, ...substituteAll(definition.environment, workspace) };
  // The stand-in Dsc.PipelineRunner writes the arguments it was called with here.
  environment.DSCPR_TEST_CALL_FILE = path.join(workspace, 'call.json');
  for (const variable of Object.keys(environment)) {
    // Nothing of the CI system this runs under may leak into the step: the task must decide
    // everything from what an Azure Pipelines agent gives it.
    if (/^(GITHUB_|RUNNER_|INPUT_|DSCPR_(?!TEST_))/.test(variable) || variable === 'CI') delete environment[variable];
  }
  if (definition.hidePowerShell) {
    const empty = path.join(root, name, 'empty-path');
    fs.mkdirSync(empty, { recursive: true });
    environment.PATH = empty;
    delete environment.Path;
  }

  const step = agent.runStep({
    taskDirectory,
    inputs: substituteAll(definition.inputs, workspace),
    variables: substituteAll(definition.variables, workspace),
    secretVariables: substituteAll(definition.secretVariables, workspace),
    environment,
    workingDirectory: workspace,
  });
  return { definition, step, failures: checkCase(definition, step, workspace) };
}

function main() {
  const vsix = argument('vsix');
  const only = argument('case');
  if (!vsix) {
    console.error('Usage: run-cases.js --vsix <file.vsix> [--case <text>]');
    process.exit(2);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-azdo-'));
  const extension = agent.extractVsix(path.resolve(vsix), path.join(root, 'extension'));
  const tasks = agent.findTasks(extension);
  if (tasks.length !== 1) {
    console.error(`The extension contributes ${tasks.length} tasks; expected exactly one.`);
    process.exit(1);
  }
  const taskDirectory = tasks[0].directory;
  const task = agent.readTask(taskDirectory);
  console.log(`Task ${task.name} ${task.version.Major}.${task.version.Minor}.${task.version.Patch} from ${path.basename(vsix)}, run with Node ${process.version}`);

  let failed = 0;
  const packageProblems = agent.checkTaskPackage(taskDirectory);
  for (const file of ['core/Invoke-DscPipelineRunnerStep.ps1', 'core/settings.json']) {
    if (!fs.existsSync(path.join(taskDirectory, file))) packageProblems.push(`${file} is not in the packaged task`);
  }
  if (packageProblems.length > 0) {
    failed += 1;
    console.log('FAIL  the packaged task');
    for (const problem of packageProblems) console.log(`        ${problem}`);
  } else {
    console.log('ok    the packaged task is one the service and the agent accept');
  }

  const names = fs.readdirSync(casesDirectory).filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json'))).sort();
  const selected = names.filter((name) => !only || name.includes(only));
  if (selected.length === 0) {
    console.error('No case matches.');
    process.exit(2);
  }
  for (const name of selected) {
    let outcome;
    try {
      outcome = runCase(name, taskDirectory, root);
    } catch (error) {
      failed += 1;
      console.log(`FAIL  ${name}\n        ${error.message}`);
      continue;
    }
    if (outcome.failures.length === 0) {
      console.log(`ok    ${name}  (${outcome.step.result})`);
      continue;
    }
    failed += 1;
    console.log(`FAIL  ${name}  -  ${outcome.definition.description || ''}`);
    for (const failure of outcome.failures) console.log(`        ${failure}`);
    console.log('        ---- step log (secrets masked, as in the pipeline) ----');
    for (const line of outcome.step.log.split(/\r?\n/)) console.log(`        | ${line}`);
  }

  console.log(failed ? `\n${failed} of ${selected.length + 1} check(s) failed (the package, and ${selected.length} case(s)).` : `\nThe package and all ${selected.length} case(s) passed.`);
  if (!process.env.DSCPR_KEEP_WORK) fs.rmSync(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main();
