#!/usr/bin/env node
'use strict';
// Runs the GitLab integration cases against the component in this working tree.
//
//   node tests/integration/gitlab/run-cases.js [--case <text>] [--shell bash|pwsh]
//
// For each case in cases/, the component is included with the case's inputs the way a pipeline
// would include it (component.js), and the job is run the way a shell runner runs it (runner.js).
// The job fetches the step script from DSCPR_CORE_URL; here that is a local web server serving
// this repository's core/, set on the job the way a pipeline overrides a component's variable,
// so what runs is the working tree, not a published tag. A case is a folder with a case.json:
//
//   description       what the case shows
//   workspace         { "<folder in the project>": "<path in this repository>" } to copy in
//   inputs            the component's inputs, as in an include
//   job               the pipeline's own definition of the job, merged on top (variables, ...)
//   variables         the pipeline's CI/CD variables
//   maskedVariables   the pipeline's masked CI/CD variables
//   environment       extra environment of the runner machine
//   hidePowerShell    true to run the job with a PATH that has no pwsh
//   expect.status     success or failed
//   expect.exitCode   the exit code of the script
//   expect.problems   regular expressions the pipeline editor's problems must match (the job is then not run)
//   expect.inputProblems   regular expressions the input errors must match (the job is then not built)
//   expect.dotenv     variables the dotenv report must set (a value may be {"matches": "<regex>"})
//   expect.artifacts  paths that must have been collected as artifacts
//   expect.contains / notContains   regular expressions for the log (unmasked)
//   expect.call       values the stand-in Dsc.PipelineRunner must have been called with ("A.B" for nested;
//                     a value may be {"matches": "<regex>"})
//   expect.notCalled  true when the module must not have been called at all
//
// In values, {repo} is this repository, {project} the project directory and {pathsep} the PATH
// separator.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const component = require('./component.js');
const runner = require('./runner.js');

const repository = path.resolve(__dirname, '..', '..', '..');
const casesDirectory = path.join(__dirname, 'cases');
const templatePath = path.join(repository, 'templates', 'dsc-pipeline-runner.yml');
const STAGES = ['test'];

function argument(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

// A web server for core/, standing in for raw.githubusercontent.com.
function serveCore() {
  const root = path.join(repository, 'core');
  const server = http.createServer((request, response) => {
    const file = path.join(root, path.normalize(decodeURIComponent(request.url.replace(/^\/core\//, '/'))));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/core/` }));
  });
}

function substitute(value, project) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('{repo}', repository).replaceAll('{project}', project).replaceAll('{pathsep}', path.delimiter);
}

function substituteDeep(node, project) {
  if (typeof node === 'string') return substitute(node, project);
  if (Array.isArray(node)) return node.map((item) => substituteDeep(item, project));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substituteDeep(value, project)]));
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

function checkOutcome(definition, outcome, project) {
  const expect = definition.expect || {};
  const failures = [];
  if (outcome.stage === 'inputs') {
    if (!expect.inputProblems) return [`the component refused the inputs: ${outcome.error}`];
    for (const pattern of expect.inputProblems) if (!new RegExp(pattern).test(outcome.error)) failures.push(`the input errors do not match /${pattern}/: ${outcome.error}`);
    return failures;
  }
  if (expect.inputProblems) failures.push('the component accepted the inputs, and must not have');
  if (outcome.stage === 'editor') {
    if (!expect.problems) return [`the pipeline editor refused the job: ${outcome.problems.join('; ')}`];
    for (const pattern of expect.problems) if (!outcome.problems.some((problem) => new RegExp(pattern).test(problem))) failures.push(`no editor problem matches /${pattern}/: ${outcome.problems.join('; ')}`);
    return failures;
  }
  if (expect.problems) failures.push('the pipeline editor accepted the job, and must not have');

  const { result } = outcome;
  if (expect.status && result.status !== expect.status) failures.push(`status is ${result.status}, expected ${expect.status}`);
  if (expect.exitCode !== undefined && result.exitCode !== expect.exitCode) failures.push(`exit code is ${result.exitCode}, expected ${expect.exitCode}`);
  for (const [name, wanted] of Object.entries(expect.dotenv || {})) {
    if (!(name in result.dotenv.variables)) failures.push(`the dotenv report does not set ${name}${result.dotenv.found ? '' : ' (there is no report)'}`);
    else if (!matchValue(result.dotenv.variables[name], typeof wanted === 'string' ? substitute(wanted, project) : wanted)) failures.push(`dotenv ${name} is '${result.dotenv.variables[name]}', expected ${describeWanted(wanted)}`);
  }
  for (const artifact of expect.artifacts || []) {
    if (!result.artifacts.some((found) => found === artifact || found.startsWith(`${artifact}/`) || found.startsWith(`${artifact}\\`))) failures.push(`'${artifact}' was not collected as an artifact (collected: ${result.artifacts.join(', ') || 'nothing'})`);
  }
  for (const pattern of expect.contains || []) if (!new RegExp(pattern).test(result.raw)) failures.push(`the log does not match /${pattern}/`);
  for (const pattern of expect.notContains || []) if (new RegExp(pattern).test(result.raw)) failures.push(`the log matches /${pattern}/, which it must not`);

  const callFile = path.join(project, 'dsc-reports', 'call.json');
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

function runCase(name, template, root, coreUrl, shell) {
  const definition = JSON.parse(fs.readFileSync(path.join(casesDirectory, name, 'case.json'), 'utf8'));
  const project = path.join(root, name, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const [target, source] of Object.entries(definition.workspace || {})) fs.cpSync(path.join(repository, source), path.join(project, target), { recursive: true });

  const inputs = substituteDeep(definition.inputs || {}, project);
  const jobName = inputs.job_name || 'dsc-pipeline-runner';
  // The pipeline's own definition of the job: what the case gives, plus where the step script
  // comes from and where the stand-in module records its call (inside the report directory, so it
  // is an artifact).
  const local = substituteDeep(definition.job || {}, project);
  local.variables = { DSCPR_CORE_URL: coreUrl, DSCPR_TEST_CALL_FILE: '$CI_PROJECT_DIR/dsc-reports/call.json', ...(local.variables || {}) };

  let built;
  try {
    built = component.buildJob(template, inputs, { [jobName]: local }, STAGES);
  } catch (error) {
    return { definition, outcome: { stage: 'inputs', error: error.message }, project };
  }
  if (built.problems.length > 0) return { definition, outcome: { stage: 'editor', problems: built.problems }, project };

  const environment = { ...process.env, ...substituteDeep(definition.environment || {}, project) };
  for (const variable of Object.keys(environment)) {
    // Nothing of the CI system this runs under may leak into the job.
    if (/^(GITHUB_|RUNNER_|INPUT_|DSCPR_|CI_)/.test(variable) || variable === 'CI' || variable === 'GITLAB_CI') delete environment[variable];
  }
  if (definition.hidePowerShell) {
    // The job shell itself is started from the runner's PATH (runner.js), so the job's PATH can
    // be a directory with nothing in it.
    const empty = path.join(root, name, 'empty-path');
    fs.mkdirSync(empty, { recursive: true });
    environment.PATH = empty;
    delete environment.Path;
  }

  const result = runner.runJob({
    name: built.name, job: built.job, projectDirectory: project,
    variables: substituteDeep(definition.variables || {}, project),
    masked: Object.keys(definition.maskedVariables || {}),
    environment: { ...environment, ...substituteDeep(definition.maskedVariables || {}, project) },
    shell,
  });
  return { definition, outcome: { stage: 'run', result }, project };
}

async function main() {
  const only = argument('case');
  const shell = argument('shell');
  const template = component.readTemplate(templatePath);
  let failed = 0;

  const specProblems = component.checkSpec(template.inputs);
  if (specProblems.length > 0) {
    failed += 1;
    console.log('FAIL  the component spec');
    for (const problem of specProblems) console.log(`        ${problem}`);
  } else {
    console.log(`ok    the component spec declares ${Object.keys(template.inputs).length} inputs that GitLab accepts`);
  }

  const names = fs.readdirSync(casesDirectory).filter((name) => fs.existsSync(path.join(casesDirectory, name, 'case.json'))).sort();
  const selected = names.filter((name) => !only || name.includes(only));
  if (selected.length === 0) { console.error('No case matches.'); process.exitCode = 2; return; }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-gitlab-'));
  const core = await serveCore();
  console.log(`Step script served from ${core.url}; job shell ${shell || (process.platform === 'win32' ? 'pwsh' : 'bash')}`);
  try {
    for (const name of selected) {
      let outcome;
      try {
        outcome = runCase(name, template, root, core.url, shell);
      } catch (error) {
        failed += 1;
        console.log(`FAIL  ${name}\n        ${error.stack}`);
        continue;
      }
      const failures = checkOutcome(outcome.definition, outcome.outcome, outcome.project);
      const summary = outcome.outcome.stage === 'run' ? outcome.outcome.result.status : `refused at ${outcome.outcome.stage}`;
      if (failures.length === 0) { console.log(`ok    ${name}  (${summary})`); continue; }
      failed += 1;
      console.log(`FAIL  ${name}  -  ${outcome.definition.description || ''}`);
      for (const failure of failures) console.log(`        ${failure}`);
      if (outcome.outcome.stage === 'run') {
        console.log('        ---- job log (masked, as in GitLab) ----');
        for (const line of outcome.outcome.result.log.split(/\r?\n/)) console.log(`        | ${line}`);
      }
    }
  } finally {
    core.server.close();
    if (!process.env.DSCPR_KEEP_WORK) fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} of ${selected.length + 1} check(s) failed (the spec, and ${selected.length} case(s)).` : `\nThe spec and all ${selected.length} case(s) passed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
