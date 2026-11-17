'use strict';
// Unit tests for the Azure Pipelines task entry point. Run with:  node --test azure-devops/tests
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const taskDirectory = path.join(__dirname, '..', 'DscPipelineRunnerTask');
const entry = path.join(taskDirectory, 'index.js');
const { SETTINGS, buildEnvironment, oneLine } = require(entry);
const task = JSON.parse(fs.readFileSync(path.join(taskDirectory, 'task.json'), 'utf8'));
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'settings.json'), 'utf8')).settings;

const inputVariable = (name) => `INPUT_${name.toUpperCase()}`;

test('every task input is mapped, and to the variable the step script reads', () => {
  const mapped = new Map(SETTINGS.map(([input, variable]) => [input, variable]));
  for (const input of task.inputs) {
    assert.ok(mapped.has(input.name), `task input '${input.name}' is not mapped in index.js`);
  }
  assert.equal(mapped.size, task.inputs.length, 'index.js maps an input task.json does not declare');
  const known = new Set(settings.map((setting) => setting.env));
  for (const variable of mapped.values()) {
    assert.ok(known.has(variable), `${variable} is not a variable in core/settings.json`);
  }
});

test('the secret flag in index.js matches core/settings.json', () => {
  for (const [, variable, secret] of SETTINGS) {
    const setting = settings.find((candidate) => candidate.env === variable);
    assert.equal(secret, setting.secret, `${variable} secret flag`);
  }
});

test('an input value becomes the matching DSCPR_* variable, trimmed', () => {
  const { env, problems } = buildEnvironment({ [inputVariable('mode')]: '  Set  ', [inputVariable('configurationPath')]: 'config' });
  assert.deepEqual(problems, []);
  assert.equal(env.DSCPR_MODE, 'Set');
  assert.equal(env.DSCPR_CONFIGURATION_PATH, 'config');
  assert.equal(env.DSCPR_PLATFORM, 'azure-devops');
});

test('every input reaches its variable', () => {
  const source = {};
  for (const [input] of SETTINGS) source[inputVariable(input)] = `value-of-${input}`;
  const { env, problems } = buildEnvironment(source);
  assert.deepEqual(problems, []);
  for (const [input, variable] of SETTINGS) assert.equal(env[variable], `value-of-${input}`);
});

test('an empty input does not set the variable, and clears one already on the agent', () => {
  const { env } = buildEnvironment({ [inputVariable('engine')]: '', DSCPR_ENGINE: 'left-over', DSCPR_MODE: 'left-over' });
  assert.equal('DSCPR_ENGINE' in env, false);
  assert.equal('DSCPR_MODE' in env, false);
});

test('the rest of the environment is passed through untouched', () => {
  const { env } = buildEnvironment({ PATH: '/usr/bin', SYSTEM_ACCESSTOKEN: 'abc' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.SYSTEM_ACCESSTOKEN, 'abc');
});

test('a multi-line input keeps its lines', () => {
  const { env } = buildEnvironment({ [inputVariable('resourceModules')]: 'A@1.0.0\nB@2.0.0\n' });
  assert.equal(env.DSCPR_RESOURCE_MODULES, 'A@1.0.0\nB@2.0.0');
});

test('an undefined pipeline variable is reported, not used as the value', () => {
  const { env, problems } = buildEnvironment({ [inputVariable('sourceToken')]: '$(ConfigRepoToken)', [inputVariable('mode')]: '$(Mode)' });
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /sourceToken.*\$\(ConfigRepoToken\).*secret variable must be defined/);
  assert.match(problems.join('\n'), /Input 'mode' is \$\(Mode\)/);
  assert.equal('DSCPR_SOURCE_TOKEN' in env, false);
  assert.equal('DSCPR_MODE' in env, false);
});

test('text that merely contains $( ) is a value, not an undefined variable', () => {
  const { env, problems } = buildEnvironment({ [inputVariable('configurationPath')]: 'configs/$(Build.SourceBranchName)/x' });
  assert.deepEqual(problems, []);
  assert.equal(env.DSCPR_CONFIGURATION_PATH, 'configs/$(Build.SourceBranchName)/x');
});

test('oneLine keeps a message on one line', () => {
  assert.equal(oneLine('a\r\nb\nc'), 'a b c');
});

test('run as the task: an undefined variable fails the task before PowerShell starts', () => {
  const run = spawnSync(process.execPath, [entry], { env: { ...process.env, [inputVariable('azureDevopsToken')]: '$(Missing)' }, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /##vso\[task\.logissue type=error\]Input 'azureDevopsToken' is \$\(Missing\)/);
  assert.match(run.stdout, /##vso\[task\.complete result=Failed;\]/);
});

test('run as the task: a missing PowerShell 7 is reported with what to do', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dscpr-nopwsh-'));
  const env = { ...process.env, PATH: empty, Path: empty };
  const run = spawnSync(process.execPath, [entry], { env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /PowerShell 7 \(pwsh\) is required on the agent and was not found on PATH/);
  assert.match(run.stdout, /##vso\[task\.complete result=Failed;\]/);
});

test('task.json: versions, handlers and input types are what the agent accepts', () => {
  assert.match(task.id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.equal(task.name, 'DscPipelineRunner');
  for (const handler of Object.values(task.execution)) assert.equal(handler.target, 'index.js');
  const groups = new Set(task.groups.map((group) => group.name));
  for (const input of task.inputs) {
    assert.ok(['string', 'boolean', 'pickList', 'multiLine'].includes(input.type), `${input.name} type ${input.type}`);
    assert.ok(groups.has(input.groupName), `${input.name} is in unknown group ${input.groupName}`);
    assert.ok(input.helpMarkDown && input.label, `${input.name} needs a label and help text`);
    if (input.type === 'pickList') assert.ok(Object.keys(input.options).includes(String(input.defaultValue)), `${input.name} default is not an option`);
    if (input.visibleRule) {
      const referenced = input.visibleRule.match(/[A-Za-z]+(?= (?:=|!=))/g) || [];
      for (const name of referenced) assert.ok(task.inputs.some((other) => other.name === name), `${input.name} visibleRule refers to unknown input ${name}`);
    }
  }
});
