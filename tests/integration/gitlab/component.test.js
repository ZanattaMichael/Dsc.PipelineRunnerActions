'use strict';
// Tests of the GitLab stand-ins (component.js and runner.js), so a case that passes means what it says.
// Run with:  node --test tests/integration/gitlab/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const component = require('./component.js');
const runner = require('./runner.js');

const templatePath = path.join(__dirname, '..', '..', '..', 'templates', 'dsc-pipeline-runner.yml');
const template = component.readTemplate(templatePath);

test('the component template has a spec that GitLab accepts, and every input has a default', () => {
  assert.deepEqual(component.checkSpec(template.inputs), []);
  for (const [name, input] of Object.entries(template.inputs)) assert.ok('default' in input, `input '${name}' has no default`);
});

test('the spec checks catch what GitLab refuses', () => {
  const cases = [
    [{ 'bad name': {} }, /names may only hold/],
    [{ x: { type: 'map' } }, /type 'map'/],
    [{ x: { options: [] } }, /non-empty list/],
    [{ x: { options: ['a', 'b'], default: 'c' } }, /not one of the options/],
    [{ x: { type: 'boolean', options: [true] } }, /only allowed for string and number/],
    [{ x: { type: 'number', regex: 'a' } }, /regex is only allowed for string/],
    [{ x: { type: 'array', default: 'no' } }, /default is not a array/],
    [{ x: { typo: 1 } }, /not a spec keyword/],
  ];
  for (const [inputs, expected] of cases) {
    const problems = component.checkSpec(inputs);
    assert.ok(problems.some((problem) => expected.test(problem)), `expected ${expected} in ${JSON.stringify(problems)}`);
  }
});

test('inputs are defaulted, checked against options and typed', () => {
  const inputs = { mode: { options: ['Test', 'Set'], default: 'Test' }, tags: { type: 'array', default: [] }, count: { type: 'number', default: 1 }, name: { default: '' } };
  assert.deepEqual(component.resolveInputs(inputs, { tags: ['a'] }), { mode: 'Test', tags: ['a'], count: 1, name: '' });
  assert.throws(() => component.resolveInputs(inputs, { mode: 'Apply' }), /'mode' is 'Apply', which is not one of its options: Test, Set/);
  assert.throws(() => component.resolveInputs(inputs, { count: '1' }), /'count' must be a number/);
  assert.throws(() => component.resolveInputs(inputs, { tags: 'a' }), /'tags' must be a array/);
  assert.throws(() => component.resolveInputs(inputs, { other: 1 }), /'other' is not an input of the component/);
  assert.throws(() => component.resolveInputs({ req: { description: 'no default' } }, {}), /'req' is required/);
  assert.throws(() => component.resolveInputs({ x: { regex: '^[a-z]+$' } }, { x: 'A1' }), /does not match/);
});

test('every problem with the inputs is reported at once', () => {
  assert.throws(() => component.resolveInputs({ a: { options: ['x'] , default: 'x' }, b: { type: 'boolean', default: false } }, { a: 'y', b: 'no', c: 1 }), (error) => {
    assert.match(error.message, /'a' is 'y'/);
    assert.match(error.message, /'b' must be a boolean/);
    assert.match(error.message, /'c' is not an input/);
    return true;
  });
});

test('interpolation replaces references in keys and values, and keeps the type of a lone reference', () => {
  const resolved = { name: 'job', tags: ['a', 'b'], n: 3, flag: true };
  const rendered = component.interpolate({ '$[[ inputs.name ]]': { tags: '$[[ inputs.tags ]]', text: 'n=$[[ inputs.n ]] f=$[[inputs.flag]]', list: ['$[[ inputs.n ]]'] } }, resolved);
  assert.deepEqual(rendered, { job: { tags: ['a', 'b'], text: 'n=3 f=true', list: [3] } });
  assert.throws(() => component.interpolate('x $[[ inputs.tags ]]', resolved), /array input can only be used on its own/);
  assert.throws(() => component.interpolate('$[[ inputs.nope ]]', resolved), /does not declare/);
  assert.equal(component.interpolate('$[[ inputs.name | truncate(0,2) ]]', resolved), 'jo');
  assert.throws(() => component.interpolate('$[[ inputs.name | upcase ]]', resolved), /not an interpolation function/);
});

test('a local job of the same name is merged on top of the included one, map by map', () => {
  const included = { stage: 'test', variables: { A: '1', B: '2' }, artifacts: { paths: ['x'], when: 'always' }, script: ['a'] };
  const local = { variables: { B: '3', C: '4' }, artifacts: { paths: ['y'] } };
  assert.deepEqual(component.mergeJob(included, local), { stage: 'test', variables: { A: '1', B: '3', C: '4' }, artifacts: { paths: ['y'], when: 'always' }, script: ['a'] });
});

test('the job the template produces passes the pipeline editor checks, with the local overrides a pipeline would add', () => {
  const built = component.buildJob(template, { configuration_path: 'config', runner_tags: ['windows'] }, { 'dsc-pipeline-runner': { variables: { PSModulePath: '$CI_PROJECT_DIR/modules' } } }, ['test']);
  assert.equal(built.name, 'dsc-pipeline-runner');
  assert.deepEqual(built.problems, []);
  assert.deepEqual(built.job.tags, ['windows']);
  assert.equal(built.job.variables.DSCPR_CONFIGURATION_PATH, 'config');
  assert.equal(built.job.variables.PSModulePath, '$CI_PROJECT_DIR/modules');
  assert.equal(built.job.artifacts.when, 'always');
  assert.equal(built.job.artifacts.reports.dotenv, 'dsc-reports/outputs.env');
  assert.ok(Array.isArray(built.job.script) && built.job.script.length === 1, 'the job is one script line, valid in every job shell');
});

test('the template renames the job through job_name and puts it in the stage asked for', () => {
  const built = component.buildJob(template, { job_name: 'compliance', stage: 'verify' }, {}, ['verify']);
  assert.equal(built.name, 'compliance');
  assert.equal(built.job.stage, 'verify');
  assert.deepEqual(built.problems, []);
  assert.match(component.buildJob(template, { stage: 'nowhere' }, {}, ['test']).problems.join('\n'), /stage 'nowhere' is not in the pipeline's stages/);
});

test('the editor checks catch what GitLab refuses', () => {
  const cases = [
    [{ script: 'x', bogus: 1 }, /not a job keyword/],
    [{ stage: 'test' }, /has no script/],
    [{ script: 'x', tags: 'one' }, /tags must be a list/],
    [{ script: 'x', variables: { 'BAD-NAME': '1' } }, /not a valid variable name/],
    [{ script: 'x', artifacts: { when: 'sometimes' } }, /artifacts:when/],
    [{ script: 'x', artifacts: { paths: 'x' } }, /artifacts:paths must be a list/],
    [{ script: 'x', artifacts: { reports: { dotenv: 1 } } }, /dotenv must be a path/],
  ];
  for (const [job, expected] of cases) {
    const problems = component.checkJob('job', job, ['test']);
    assert.ok(problems.some((problem) => expected.test(problem)), `expected ${expected} in ${JSON.stringify(problems)}`);
  }
  assert.match(component.checkJob('variables', { script: 'x' }, ['test']).join('\n'), /reserved keyword/);
});

test('$VARIABLE references in variables are expanded from the other variables', () => {
  assert.deepEqual(component.expandVariables({ CI_PROJECT_DIR: '/b', A: '$CI_PROJECT_DIR/x', B: '${A}/y', C: '$MISSING' }), { CI_PROJECT_DIR: '/b', A: '/b/x', B: '/b/x/y', C: '$MISSING' });
});

test('a dotenv report is read with the rules the server applies', () => {
  const good = component.parseDotenv('DSCPR_STATUS=Completed\nexport COUNT="3"\n\n# note\nPATH_X=/a=b\n');
  assert.deepEqual(good, { variables: { DSCPR_STATUS: 'Completed', COUNT: '3', PATH_X: '/a=b' }, problems: [] });
  const bad = component.parseDotenv('no equals\n1BAD=x\n');
  assert.match(bad.problems.join('\n'), /line 1 is not KEY=VALUE/);
  assert.match(bad.problems.join('\n'), /'1BAD' is not a valid variable name/);
  const many = component.parseDotenv(Array.from({ length: 21 }, (_, index) => `V${index}=1`).join('\n'));
  assert.match(many.problems.join('\n'), /the limit is 20/);
});

test('the runner echoes each script line, stops at the first failure and keeps always-artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-gitlab-test-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const lines = shell === 'pwsh'
    ? ['New-Item -ItemType Directory out | Out-Null', 'Set-Content out/outputs.env "DSCPR_STATUS=Failed"', 'Write-Host "value is $SECRET_ONE and $CI_JOB_NAME"', 'exit 3', 'Write-Host NOT-REACHED']
    : ['mkdir out', 'echo DSCPR_STATUS=Failed > out/outputs.env', 'echo "value is $SECRET_ONE and $CI_JOB_NAME"', 'exit 3', 'echo NOT-REACHED'];
  const job = { stage: 'test', script: lines, variables: { OUT: '$CI_PROJECT_DIR/out' }, artifacts: { when: 'always', paths: ['out'], reports: { dotenv: 'out/outputs.env' } } };
  const result = runner.runJob({ name: 'j', job, projectDirectory: project, variables: { SECRET_ONE: 'hush-hush' }, masked: ['SECRET_ONE'], shell });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 3);
  assert.match(result.raw, /value is hush-hush and j/);
  assert.match(result.log, /value is \[MASKED\] and j/);
  assert.doesNotMatch(result.raw, /NOT-REACHED/);
  assert.match(result.raw, /\$ exit 3/);
  assert.deepEqual(result.artifacts, ['out']);
  assert.deepEqual(result.dotenv.variables, { DSCPR_STATUS: 'Failed' });
  assert.equal(result.environment.OUT, path.join(project, 'out').replace(/\\/g, '/').replace(project.replace(/\\/g, '/'), project));
  assert.equal(result.environment.GITLAB_CI, 'true');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an invalid dotenv report fails the job even when the script succeeded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-gitlab-test-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'bad.env'), 'this is not dotenv\n');
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const job = { script: [shell === 'pwsh' ? 'Write-Host ok' : 'echo ok'], artifacts: { reports: { dotenv: 'bad.env' } } };
  const result = runner.runJob({ name: 'j', job, projectDirectory: project, shell });
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, 'failed');
  assert.match(result.raw, /Uploading artifacts as "dotenv".*failed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('artifact paths that match nothing are warned about, as the runner does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-gitlab-test-'));
  fs.mkdirSync(path.join(root, 'reports'));
  fs.writeFileSync(path.join(root, 'reports', 'a.json'), '{}');
  assert.deepEqual(runner.collectArtifactPaths(root, ['reports', 'reports/*.json', 'missing', 'reports/*.xml']), ['reports', path.join('reports', 'a.json')]);
  fs.rmSync(root, { recursive: true, force: true });
});
