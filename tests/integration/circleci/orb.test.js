'use strict';
// Tests of the CircleCI stand-ins (orb.js and agent.js), so a case that passes means what it says.
// Run with:  node --test tests/integration/circleci/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const orbTools = require('./orb.js');
const agent = require('./agent.js');

const orb = orbTools.readOrb(path.join(__dirname, '..', '..', '..', 'circleci', 'orb.yml'));

test('the orb passes the checks, and the execute command has a default for every parameter', () => {
  assert.deepEqual(orbTools.checkOrb(orb), []);
  for (const [name, parameter] of Object.entries(orb.commands.execute.parameters)) assert.ok('default' in parameter, `parameter '${name}' has no default`);
});

test('the parameter checks catch what the orb validator refuses', () => {
  const cases = [
    [{ Bad: { type: 'string' } }, /lower-case letter/],
    [{ x: { type: 'map' } }, /type 'map'/],
    [{ x: { type: 'enum' } }, /no enum list/],
    [{ x: { type: 'enum', enum: ['a'], default: 'b' } }, /not in its enum/],
    [{ x: { type: 'boolean', default: 'true' } }, /is not a boolean/],
    [{ x: { type: 'string', defualt: '' } }, /unknown key/],
  ];
  for (const [parameters, expected] of cases) {
    const problems = orbTools.checkParameters(parameters, 'command c');
    assert.ok(problems.some((problem) => expected.test(problem)), `expected ${expected} in ${JSON.stringify(problems)}`);
  }
});

test('parameters are defaulted and typed; every problem is reported at once', () => {
  const declared = { mode: { type: 'enum', enum: ['Test', 'Set'], default: 'Test' }, flag: { type: 'boolean', default: false }, n: { type: 'integer', default: 1 }, v: { type: 'env_var_name', default: 'X' } };
  assert.deepEqual(orbTools.resolveParameters(declared, { flag: true }), { mode: 'Test', flag: true, n: 1, v: 'X' });
  assert.throws(() => orbTools.resolveParameters(declared, { mode: 'Apply', flag: 'true', n: 1.5, v: '1bad', other: 1 }), (error) => {
    assert.match(error.message, /'mode' is "Apply", which is not one of Test, Set/);
    assert.match(error.message, /'flag' must be a boolean/);
    assert.match(error.message, /'n' must be a integer/);
    assert.match(error.message, /'v' must be a env_var_name/);
    assert.match(error.message, /'other' is not a parameter/);
    return true;
  });
  assert.throws(() => orbTools.resolveParameters({ req: { type: 'string' } }, {}), /'req' is required/);
});

test('<< parameters.x >> is replaced in text, and a lone reference keeps its type', () => {
  const resolved = { name: 'n', flag: true, count: 2 };
  assert.deepEqual(orbTools.substitute({ a: 'name=<< parameters.name >> flag=<<parameters.flag>>', b: '<< parameters.flag >>', c: ['<< parameters.count >>'] }, resolved), { a: 'name=n flag=true', b: true, c: [2] });
  assert.throws(() => orbTools.substitute('<< parameters.nope >>', resolved), /does not declare/);
});

test('logic statements are evaluated as CircleCI evaluates them', () => {
  assert.equal(orbTools.evaluate(true), true);
  assert.equal(orbTools.evaluate(''), false);
  assert.equal(orbTools.evaluate('false'), false);
  assert.equal(orbTools.evaluate('x'), true);
  assert.equal(orbTools.evaluate({ and: [true, { not: false }] }), true);
  assert.equal(orbTools.evaluate({ or: [false, { equal: ['a', 'a'] }] }), true);
  assert.equal(orbTools.evaluate({ equal: ['a', 'b'] }), false);
  assert.equal(orbTools.evaluate({ matches: { pattern: '^v', value: 'v1' } }), true);
});

test('when and unless steps are taken or dropped, and unknown step types are refused', () => {
  const steps = orbTools.expandSteps([
    { when: { condition: '<< parameters.flag >>', steps: [{ run: 'echo taken' }] } },
    { unless: { condition: '<< parameters.flag >>', steps: [{ run: 'echo dropped' }] } },
    'checkout',
  ], { flag: true });
  assert.deepEqual(steps, [{ type: 'run', command: 'echo taken' }, { type: 'checkout' }]);
  assert.throws(() => orbTools.expandSteps([{ 'other/command': {} }], {}), /orb commands are expanded before this point/);
  assert.throws(() => orbTools.expandSteps([{ run: 'a', checkout: {} }], {}), /exactly one key/);
});

test('the execute command expands to one run step and one store_artifacts step that always runs', () => {
  const { steps, parameters } = orbTools.expandCommand(orb, 'execute', { 'configuration-path': 'config', 'skip-module-install': true, 'source-token-variable': 'MY_TOKEN', 'actions-ref': 'abc' });
  assert.deepEqual(steps.map((step) => step.type), ['run', 'store_artifacts']);
  assert.equal(String(steps[0].environment.DSCPR_SKIP_MODULE_INSTALL), 'true');
  assert.equal(steps[0].environment.DSCPR_SOURCE_TOKEN_VARIABLE, 'MY_TOKEN');
  assert.equal(steps[0].environment.DSCPR_CORE_URL, 'https://raw.githubusercontent.com/ZanattaMichael/Dsc.PipelineRunnerActions/abc/core/');
  assert.equal(steps[0].name, 'Dsc.PipelineRunner (Test)');
  assert.equal(steps[1].when, 'always');
  assert.equal(steps[1].path, 'dsc-reports');
  assert.equal(parameters.mode, 'Test');
  assert.doesNotMatch(steps[0].command, /<</, 'no parameter reference is left in the command');
});

test('the run job passes every parameter of the execute command through', () => {
  const commandParameters = Object.keys(orb.commands.execute.parameters);
  const given = orb.jobs.run.steps.find((step) => step && typeof step === 'object' && 'execute' in step).execute;
  for (const name of commandParameters) assert.equal(given[name], `<< parameters.${name} >>`, `the run job does not pass '${name}' to the execute command`);
  for (const name of Object.keys(given)) assert.ok(commandParameters.includes(name), `the run job passes '${name}', which the execute command does not declare`);
});

test('the agent runs steps in order, stops at a failure except for always steps, and masks context secrets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-circleci-test-'));
  const workdir = path.join(root, 'project');
  fs.mkdirSync(workdir);
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
  const say = (text) => (shell === 'pwsh' ? `Write-Host "${text}"` : `echo "${text}"`);
  const steps = [
    { type: 'run', name: 'first', command: `${say('token=$TOKEN job=$CIRCLE_JOB step=$STEP_VAR')}`, environment: { STEP_VAR: 's' } },
    { type: 'run', name: 'fails', command: shell === 'pwsh' ? 'exit 2' : 'exit 2' },
    { type: 'run', name: 'skipped', command: say('NOT-REACHED') },
    { type: 'run', name: 'cleanup', command: say('ALWAYS'), when: 'always' },
    { type: 'store_artifacts', path: 'missing', destination: 'd', when: 'always' },
  ];
  const result = agent.runSteps({ steps, workingDirectory: workdir, jobName: 'j', context: { TOKEN: 'hush-hush' }, shell });
  assert.equal(result.status, 'failed');
  assert.match(result.raw, /token=hush-hush job=j step=s/);
  assert.match(result.log, /token=\*\*\*\* job=j/);
  assert.doesNotMatch(result.raw, /NOT-REACHED/);
  assert.match(result.raw, /ALWAYS/);
  assert.deepEqual(result.steps.map((step) => [step.name, step.ran]), [['first', true], ['fails', true], ['skipped', false], ['cleanup', true], ['store_artifacts', true]]);
  assert.equal(result.steps[1].exitCode, 2);
  assert.equal(result.steps[4].exists, false);
  fs.rmSync(root, { recursive: true, force: true });
});
