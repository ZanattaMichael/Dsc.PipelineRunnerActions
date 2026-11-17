'use strict';
// A stand-in for the part of the Azure Pipelines agent that runs a Node task.
//
// The real agent needs an Azure DevOps organization to register with, so CI cannot start one.
// This file does what the agent does between "the job has a task step" and "the step has a
// result", for a task taken out of the packaged extension (.vsix):
//
//   * finds the task in the extension manifest, the way the service does when it installs it
//   * resolves the step's inputs: task.json defaults, then the step's own values, then $(variable)
//     macros (a macro for a variable that is not defined is left as written)
//   * passes inputs as INPUT_<NAME> and non-secret variables as environment variables; secret
//     variables are never put in the environment
//   * runs the execution handler's target with Node, in the default working directory
//   * reads the logging commands (##vso[...]) from the output and works out the step result and
//     the output variables
//
// The live tests (live/) run the same task on a real agent; see README.md in this folder.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TASK_CONTRIBUTION = 'ms.vss-distributed-task.task';
const NODE_HANDLERS = ['Node24', 'Node20_1', 'Node16', 'Node10', 'Node'];

// ---- The package -------------------------------------------------------------------------------

function extractVsix(vsixPath, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // A .vsix is a zip file. Windows has no unzip, and its tar (bsdtar) reads zip files.
  const [command, args] = process.platform === 'win32'
    ? ['tar', ['-xf', vsixPath, '-C', destination]]
    : ['unzip', ['-q', '-o', vsixPath, '-d', destination]];
  const run = spawnSync(command, args, { encoding: 'utf8' });
  if (run.error) throw new Error(`Could not run ${command}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${command} could not extract ${vsixPath}: ${run.stderr}`);
  return destination;
}

// The folders of the tasks the extension contributes, from its manifest.
function findTasks(extensionDirectory) {
  const manifestPath = path.join(extensionDirectory, 'extension.vsomanifest');
  if (!fs.existsSync(manifestPath)) throw new Error('The package has no extension.vsomanifest.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return (manifest.contributions || [])
    .filter((contribution) => contribution.type === TASK_CONTRIBUTION)
    .map((contribution) => ({
      id: contribution.id,
      directory: path.join(extensionDirectory, contribution.properties.name),
    }));
}

function readTask(taskDirectory) {
  return JSON.parse(fs.readFileSync(path.join(taskDirectory, 'task.json'), 'utf8'));
}

// What the service and the agent require of a task before it can be installed and run.
function checkTaskPackage(taskDirectory) {
  const problems = [];
  if (!fs.existsSync(path.join(taskDirectory, 'task.json'))) return [`${taskDirectory} has no task.json`];
  const task = readTask(taskDirectory);

  if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(task.id || '')) problems.push(`id '${task.id}' is not a GUID`);
  if (!/^[A-Za-z0-9-]+$/.test(task.name || '')) problems.push(`name '${task.name}' may only hold letters, digits and hyphens`);
  if (!task.friendlyName) problems.push('friendlyName is empty');
  if (!task.instanceNameFormat) problems.push('instanceNameFormat is empty');
  for (const part of ['Major', 'Minor', 'Patch']) {
    if (!Number.isInteger(task.version && task.version[part])) problems.push(`version.${part} is not an integer`);
  }
  if (task.minimumAgentVersion && !/^\d+\.\d+\.\d+$/.test(task.minimumAgentVersion)) {
    problems.push(`minimumAgentVersion '${task.minimumAgentVersion}' is not a version`);
  }

  const inputs = task.inputs || [];
  const names = new Set();
  const groups = new Set((task.groups || []).map((group) => group.name));
  for (const input of inputs) {
    const lower = String(input.name).toLowerCase();
    if (names.has(lower)) problems.push(`input '${input.name}' is declared twice (input names are not case sensitive)`);
    names.add(lower);
    if (!input.type) problems.push(`input '${input.name}' has no type`);
    if (!input.label) problems.push(`input '${input.name}' has no label`);
    if (input.groupName && !groups.has(input.groupName)) problems.push(`input '${input.name}' is in group '${input.groupName}', which is not declared`);
    if (input.type === 'pickList') {
      const options = Object.keys(input.options || {});
      if (options.length === 0) problems.push(`pickList '${input.name}' has no options`);
      else if (input.defaultValue !== undefined && input.defaultValue !== '' && !options.includes(String(input.defaultValue))) {
        problems.push(`pickList '${input.name}' defaults to '${input.defaultValue}', which is not one of its options`);
      }
    }
    for (const match of String(input.visibleRule || '').matchAll(/([A-Za-z0-9_.]+)\s*(?:!=|=|==)/g)) {
      if (!inputs.some((other) => other.name === match[1])) problems.push(`visibleRule of '${input.name}' refers to '${match[1]}', which is not an input`);
    }
  }
  for (const match of String(task.instanceNameFormat || '').matchAll(/\$\(([^)]+)\)/g)) {
    if (!names.has(match[1].toLowerCase())) problems.push(`instanceNameFormat refers to $(${match[1]}), which is not an input`);
  }
  for (const variable of task.outputVariables || []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name || '')) problems.push(`output variable '${variable.name}' is not a valid variable name`);
  }

  const handlers = Object.keys(task.execution || {});
  if (handlers.length === 0) problems.push('execution declares no handler');
  for (const handler of handlers) {
    const target = task.execution[handler].target;
    if (!target) problems.push(`execution.${handler} has no target`);
    else if (!fs.existsSync(path.join(taskDirectory, target))) problems.push(`execution.${handler}.target '${target}' is not in the package`);
  }
  if (!handlers.some((handler) => NODE_HANDLERS.includes(handler))) problems.push('execution has no Node handler');
  return problems;
}

// ---- The step ----------------------------------------------------------------------------------

function inputVariableName(name) {
  return `INPUT_${String(name).replace(/[ .]/g, '_').toUpperCase()}`;
}

function variableEnvironmentName(name) {
  return String(name).replace(/[ .]/g, '_').toUpperCase();
}

// Replaces $(name) with the variable's value. Names are not case sensitive. A macro for a variable
// that is not defined stays as written, which is what the task then receives.
function expandMacros(value, variables) {
  const lookup = new Map(Object.entries(variables).map(([name, text]) => [name.toLowerCase(), String(text)]));
  let text = String(value);
  for (let pass = 0; pass < 50; pass += 1) {
    const next = text.replace(/\$\(([^)]+)\)/g, (macro, name) => (lookup.has(name.toLowerCase()) ? lookup.get(name.toLowerCase()) : macro));
    if (next === text) break;
    text = next;
  }
  return text;
}

// The inputs the task receives for a step: every declared input, defaulted, then expanded.
function resolveInputs(task, stepInputs, variables) {
  const declared = new Map((task.inputs || []).map((input) => [input.name.toLowerCase(), input]));
  for (const name of Object.keys(stepInputs)) {
    if (!declared.has(name.toLowerCase())) throw new Error(`The step sets '${name}', which is not an input of the task.`);
  }
  const given = new Map(Object.entries(stepInputs).map(([name, value]) => [name.toLowerCase(), value]));
  const resolved = {};
  for (const input of task.inputs || []) {
    const raw = given.has(input.name.toLowerCase()) ? given.get(input.name.toLowerCase()) : input.defaultValue;
    resolved[input.name] = expandMacros(raw === undefined || raw === null ? '' : String(raw), variables);
  }
  return resolved;
}

// ---- Logging commands --------------------------------------------------------------------------

function unescapeCommandValue(text) {
  return String(text).replace(/%3B/gi, ';').replace(/%0D/gi, '\r').replace(/%0A/gi, '\n').replace(/%5D/gi, ']').replace(/%AZP25/gi, '%');
}

// One line of task output, as a logging command, or null when it is not one.
function parseCommand(line) {
  const match = /##vso\[([A-Za-z]+)\.([A-Za-z]+)([^\]]*)\](.*)$/.exec(line);
  if (!match) return null;
  const properties = {};
  for (const pair of match[3].trim().split(';')) {
    const at = pair.indexOf('=');
    if (at > 0) properties[pair.slice(0, at).trim().toLowerCase()] = unescapeCommandValue(pair.slice(at + 1));
  }
  return { area: match[1].toLowerCase(), action: match[2].toLowerCase(), properties, data: unescapeCommandValue(match[4]) };
}

// The step result and the variables the output sets, as the agent derives them.
function readOutput(output, exitCode) {
  const commands = [];
  const outputs = {};
  const variables = {};
  const secrets = [];
  const issues = [];
  let completed = null;
  for (const line of output.split(/\r?\n/)) {
    const command = parseCommand(line);
    if (!command) continue;
    commands.push(command);
    const name = `${command.area}.${command.action}`;
    if (name === 'task.setvariable') {
      const target = command.properties.isoutput === 'true' ? outputs : variables;
      target[command.properties.variable] = command.data;
      if (command.properties.issecret === 'true') secrets.push(command.data);
    } else if (name === 'task.logissue') {
      issues.push({ type: (command.properties.type || '').toLowerCase(), message: command.data });
    } else if (name === 'task.complete') {
      completed = command.properties.result || null;
    } else if (name === 'task.setsecret') {
      secrets.push(command.data);
    }
  }
  let result = 'Succeeded';
  if (completed) result = completed;
  // A handler process that exits with a non-zero code fails the step whatever it logged.
  if (exitCode !== 0) result = 'Failed';
  return { commands, outputs, variables, secrets, issues, result };
}

// What a person reading the pipeline log sees: the agent replaces every secret value with ***.
function maskSecrets(text, secrets) {
  let masked = text;
  for (const secret of secrets.filter((value) => value !== '').sort((a, b) => b.length - a.length)) {
    masked = masked.split(secret).join('***');
  }
  return masked;
}

/**
 * Runs one step of the task.
 *   taskDirectory      the task's folder in the extracted extension
 *   inputs             the step's inputs, as written in the pipeline
 *   variables          pipeline variables (available as macros and as environment variables)
 *   secretVariables    secret pipeline variables (available as macros only)
 *   environment        what the agent machine has in its environment (PATH and so on)
 *   workingDirectory   the default working directory (the sources folder)
 */
function runStep({ taskDirectory, inputs = {}, variables = {}, secretVariables = {}, environment = process.env, workingDirectory }) {
  const task = readTask(taskDirectory);
  const handlerName = NODE_HANDLERS.find((name) => task.execution && task.execution[name]);
  if (!handlerName) throw new Error('The task has no Node execution handler.');
  const target = path.join(taskDirectory, task.execution[handlerName].target);

  const agentVariables = {
    'Agent.Name': 'agent-stand-in',
    'Agent.OS': process.platform === 'win32' ? 'Windows_NT' : process.platform === 'darwin' ? 'Darwin' : 'Linux',
    'Agent.TempDirectory': path.join(workingDirectory, '..', '_temp'),
    'Build.SourcesDirectory': workingDirectory,
    'System.DefaultWorkingDirectory': workingDirectory,
    'System.TeamProject': 'integration',
    'System.CollectionUri': 'https://dev.azure.com/integration/',
    TF_BUILD: 'True',
  };
  const allVariables = { ...agentVariables, ...variables };
  const resolved = resolveInputs(task, inputs, { ...allVariables, ...secretVariables });

  const env = { ...environment };
  for (const [name, value] of Object.entries(allVariables)) env[variableEnvironmentName(name)] = String(value);
  for (const [name, value] of Object.entries(resolved)) env[inputVariableName(name)] = value;
  for (const name of Object.keys(secretVariables)) delete env[variableEnvironmentName(name)];
  fs.mkdirSync(agentVariables['Agent.TempDirectory'], { recursive: true });

  const run = spawnSync(process.execPath, [target], { env, cwd: workingDirectory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`Could not start the task: ${run.error.message}`);
  const raw = `${run.stdout || ''}${run.stderr || ''}`;
  const exitCode = run.status === null ? 1 : run.status;
  const read = readOutput(raw, exitCode);
  const secrets = [...Object.values(secretVariables).map(String), ...read.secrets];
  return { handler: handlerName, inputs: resolved, exitCode, raw, log: maskSecrets(raw, secrets), ...read };
}

module.exports = {
  extractVsix, findTasks, readTask, checkTaskPackage, inputVariableName, variableEnvironmentName,
  expandMacros, resolveInputs, parseCommand, readOutput, maskSecrets, runStep,
};
