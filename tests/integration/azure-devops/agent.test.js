'use strict';
// Tests of the agent stand-in itself, so a case that passes means what it says.
// Run with:  node --test tests/integration/azure-devops/agent.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agent = require('./agent.js');

const realTask = path.join(__dirname, '..', '..', '..', 'azure-devops', 'DscPipelineRunnerTask');

function temporaryTask(change) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-agent-test-'));
  const task = agent.readTask(realTask);
  change(task);
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify(task));
  fs.writeFileSync(path.join(directory, 'index.js'), '');
  return directory;
}

test('a macro is replaced by its variable, whatever the case of the name', () => {
  assert.equal(agent.expandMacros('a $(One) b $(TWO)', { one: '1', Two: '2' }), 'a 1 b 2');
});

test('a macro for a variable that is not defined is left as written', () => {
  assert.equal(agent.expandMacros('$(Missing)', { Other: 'x' }), '$(Missing)');
});

test('a variable that refers to another variable is expanded too', () => {
  assert.equal(agent.expandMacros('$(Outer)', { Outer: 'in $(Inner)', Inner: 'deep' }), 'in deep');
});

test('a variable that refers to itself does not loop for ever', () => {
  assert.equal(typeof agent.expandMacros('$(Loop)', { Loop: 'x$(Loop)' }), 'string');
});

test('inputs the step leaves out get the default from task.json', () => {
  const task = agent.readTask(realTask);
  const inputs = agent.resolveInputs(task, { configurationPath: 'config' }, {});
  assert.equal(inputs.configurationPath, 'config');
  assert.equal(inputs.mode, 'Test');
  assert.equal(inputs.failOnError, 'true');
  assert.equal(inputs.reportPath, 'dsc-reports');
  assert.equal(Object.keys(inputs).length, task.inputs.length);
});

test('a step input that the task does not declare is an error in the case', () => {
  assert.throws(() => agent.resolveInputs(agent.readTask(realTask), { configurationPth: 'x' }, {}), /not an input of the task/);
});

test('input and variable names become environment names the way the agent makes them', () => {
  assert.equal(agent.inputVariableName('azureDevopsToken'), 'INPUT_AZUREDEVOPSTOKEN');
  assert.equal(agent.inputVariableName('a.b c'), 'INPUT_A_B_C');
  assert.equal(agent.variableEnvironmentName('System.DefaultWorkingDirectory'), 'SYSTEM_DEFAULTWORKINGDIRECTORY');
});

test('a logging command is read with its properties and its escaped text', () => {
  const command = agent.parseCommand('##vso[task.setvariable variable=status;isOutput=true]Completed');
  assert.deepEqual(command, { area: 'task', action: 'setvariable', properties: { variable: 'status', isoutput: 'true' }, data: 'Completed' });
  assert.equal(agent.parseCommand('##vso[task.logissue type=error]a%3Bb%0Ac %AZP25').data, 'a;b\nc %');
  assert.equal(agent.parseCommand('just a line'), null);
  assert.equal(agent.parseCommand('## vso[task.complete result=Failed;]defused'), null);
});

test('the step result follows the exit code and task.complete', () => {
  assert.equal(agent.readOutput('hello', 0).result, 'Succeeded');
  assert.equal(agent.readOutput('hello', 3).result, 'Failed');
  assert.equal(agent.readOutput('##vso[task.complete result=Failed;]no', 0).result, 'Failed');
  assert.equal(agent.readOutput('##vso[task.complete result=SucceededWithIssues;]', 0).result, 'SucceededWithIssues');
  // An error that is only logged does not fail the step.
  assert.equal(agent.readOutput('##vso[task.logissue type=error]bad', 0).result, 'Succeeded');
});

test('output variables, plain variables and issues are told apart', () => {
  const read = agent.readOutput([
    '##vso[task.setvariable variable=status;isOutput=true]Completed',
    '##vso[task.setvariable variable=local]1',
    '##vso[task.setvariable variable=token;issecret=true]hide-me',
    '##vso[task.logissue type=warning]careful',
  ].join('\n'), 0);
  assert.deepEqual(read.outputs, { status: 'Completed' });
  assert.deepEqual(read.variables, { local: '1', token: 'hide-me' });
  assert.deepEqual(read.secrets, ['hide-me']);
  assert.deepEqual(read.issues, [{ type: 'warning', message: 'careful' }]);
});

test('secrets are replaced in the log, longest first', () => {
  assert.equal(agent.maskSecrets('abc abcdef', ['abc', 'abcdef', '']), '*** ***');
});

test('the task in this repository passes the package checks', () => {
  // The repository keeps no copy of core/ in the task folder, so only task.json is checked here.
  assert.deepEqual(agent.checkTaskPackage(realTask), []);
});

test('the package checks catch what the service would refuse', () => {
  const cases = [
    [(task) => { task.id = 'not-a-guid'; }, /is not a GUID/],
    [(task) => { task.name = 'has space'; }, /letters, digits and hyphens/],
    [(task) => { task.version.Patch = '1'; }, /version\.Patch is not an integer/],
    [(task) => { task.execution = { Node20_1: { target: 'missing.js' } }; }, /is not in the package/],
    [(task) => { task.execution = { PowerShell3: { target: 'index.js' } }; }, /no Node handler/],
    [(task) => { task.inputs.push({ ...task.inputs[0], name: task.inputs[0].name.toUpperCase() }); }, /declared twice/],
    [(task) => { task.inputs[0].groupName = 'nowhere'; }, /which is not declared/],
    [(task) => { task.inputs.find((input) => input.type === 'pickList').defaultValue = 'Nope'; }, /not one of its options/],
    [(task) => { task.inputs.find((input) => input.visibleRule).visibleRule = 'ghost = 1'; }, /refers to 'ghost'/],
    [(task) => { task.instanceNameFormat = 'Run $(ghost)'; }, /instanceNameFormat refers to/],
    [(task) => { task.outputVariables.push({ name: 'bad-name' }); }, /not a valid variable name/],
  ];
  for (const [change, expected] of cases) {
    const problems = agent.checkTaskPackage(temporaryTask(change));
    assert.ok(problems.some((problem) => expected.test(problem)), `expected ${expected} in ${JSON.stringify(problems)}`);
  }
});

test('a step gets inputs and variables in its environment, and never a secret variable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-agent-test-'));
  fs.writeFileSync(path.join(directory, 'task.json'), JSON.stringify({
    inputs: [{ name: 'token' }, { name: 'plain', defaultValue: 'default' }],
    execution: { Node20_1: { target: 'echo.js' } },
  }));
  fs.writeFileSync(path.join(directory, 'echo.js'),
    "for (const name of ['INPUT_TOKEN', 'INPUT_PLAIN', 'SHOWN', 'HIDDEN', 'TF_BUILD']) console.log(`${name}=${process.env[name]}`);" +
    "console.log('cwd=' + process.cwd()); process.exitCode = 4;");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-agent-ws-'));
  const sources = path.join(workspace, 's');
  fs.mkdirSync(sources);
  const step = agent.runStep({
    taskDirectory: directory, inputs: { token: '$(Hidden)' }, variables: { Shown: 'yes' },
    secretVariables: { Hidden: 'sssh-secret' }, workingDirectory: sources,
  });
  assert.match(step.raw, /INPUT_TOKEN=sssh-secret/);
  assert.match(step.raw, /INPUT_PLAIN=default/);
  assert.match(step.raw, /SHOWN=yes/);
  assert.match(step.raw, /HIDDEN=undefined/);
  assert.match(step.raw, /TF_BUILD=True/);
  assert.ok(step.raw.includes(`cwd=${fs.realpathSync(sources)}`) || step.raw.includes(`cwd=${sources}`));
  assert.match(step.log, /INPUT_TOKEN=\*\*\*/);
  assert.equal(step.exitCode, 4);
  assert.equal(step.result, 'Failed');
});
