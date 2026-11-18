'use strict';
// A stand-in for what CircleCI does with an orb command before the build agent runs its steps.
//
// CircleCI processes a configuration on its servers, so this file does what that processing does
// for one use of the orb's `run` command:
//
//   * reads the orb and finds the command
//   * resolves the parameters the step gives against the command's declaration: defaults,
//     required parameters, types (string, boolean, integer, enum, env_var_name)
//   * replaces << parameters.name >> in the command's steps (a boolean becomes true or false,
//     an integer its digits)
//   * evaluates `when` and `unless` steps with the logic statements a config may use
//   * checks the step types the agent knows
//
// The live tests (live/) run the same cases with the CircleCI CLI's local execute, which uses the
// real processing and the real build agent; see README.md in this folder.

const fs = require('node:fs');
const YAML = require('yaml');

const STEP_TYPES = new Set(['run', 'checkout', 'setup_remote_docker', 'save_cache', 'restore_cache', 'store_artifacts', 'store_test_results',
  'persist_to_workspace', 'attach_workspace', 'add_ssh_keys', 'when', 'unless', 'deploy']);
const PARAMETER_TYPES = new Set(['string', 'boolean', 'integer', 'enum', 'executor', 'steps', 'env_var_name']);

function readOrb(path) {
  const document = YAML.parseDocument(fs.readFileSync(path, 'utf8'));
  if (document.errors.length > 0) throw new Error(`${path}: ${document.errors[0].message}`);
  const orb = document.toJS();
  if (orb.version !== 2.1) throw new Error(`${path}: an orb must declare version 2.1.`);
  return orb;
}

// Problems the orb validator would report about a command's or job's parameter declarations.
function checkParameters(parameters, where) {
  const problems = [];
  for (const [name, parameter] of Object.entries(parameters || {})) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) problems.push(`${where}: parameter '${name}' must start with a lower-case letter and hold only lower-case letters, digits, _ and -`);
    if (!parameter || typeof parameter !== 'object') { problems.push(`${where}: parameter '${name}' is not a map`); continue; }
    if (!PARAMETER_TYPES.has(parameter.type)) problems.push(`${where}: parameter '${name}' has type '${parameter.type}', which is not one of ${[...PARAMETER_TYPES].join(', ')}`);
    if (parameter.type === 'enum') {
      if (!Array.isArray(parameter.enum) || parameter.enum.length === 0) problems.push(`${where}: enum parameter '${name}' has no enum list`);
      else if ('default' in parameter && !parameter.enum.includes(parameter.default)) problems.push(`${where}: parameter '${name}' defaults to '${parameter.default}', which is not in its enum`);
    }
    if ('default' in parameter && !valueHasType(parameter.default, parameter)) problems.push(`${where}: the default of parameter '${name}' is not a ${parameter.type}`);
    for (const key of Object.keys(parameter)) if (!['type', 'description', 'default', 'enum'].includes(key)) problems.push(`${where}: parameter '${name}' has an unknown key '${key}'`);
  }
  return problems;
}

function valueHasType(value, parameter) {
  switch (parameter.type) {
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'enum': return (parameter.enum || []).includes(value);
    case 'env_var_name': return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
    case 'executor': return typeof value === 'string' || (value && typeof value === 'object');
    case 'steps': return Array.isArray(value);
    default: return false;
  }
}

// The parameter values a use of the command gets. Throws with every problem at once.
function resolveParameters(declared, given) {
  const problems = [];
  const resolved = {};
  for (const name of Object.keys(given)) if (!(name in (declared || {}))) problems.push(`'${name}' is not a parameter of the command`);
  for (const [name, parameter] of Object.entries(declared || {})) {
    let value;
    if (name in given) value = given[name];
    else if ('default' in parameter) value = parameter.default;
    else { problems.push(`'${name}' is required and was not given`); continue; }
    if (!valueHasType(value, parameter)) {
      problems.push(parameter.type === 'enum'
        ? `'${name}' is ${JSON.stringify(value)}, which is not one of ${parameter.enum.join(', ')}`
        : `'${name}' must be a ${parameter.type}; ${JSON.stringify(value)} is not`);
      continue;
    }
    resolved[name] = value;
  }
  if (problems.length > 0) throw new Error(`The command's parameters are not valid:\n  ${problems.join('\n  ')}`);
  return resolved;
}

function render(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function substituteString(text, resolved) {
  return text.replace(/<<\s*parameters\.([a-z][a-z0-9_-]*)\s*>>/g, (match, name) => {
    if (!(name in resolved)) throw new Error(`'${match}' refers to a parameter the command does not declare.`);
    return render(resolved[name]);
  });
}

// A value that is exactly one parameter reference keeps the parameter's type (so a boolean
// parameter can drive a `when`); anything else is text substitution.
function substitute(node, resolved) {
  if (typeof node === 'string') {
    const whole = /^\s*<<\s*parameters\.([a-z][a-z0-9_-]*)\s*>>\s*$/.exec(node);
    if (whole) {
      if (!(whole[1] in resolved)) throw new Error(`'${node}' refers to a parameter the command does not declare.`);
      return resolved[whole[1]];
    }
    return substituteString(node, resolved);
  }
  if (Array.isArray(node)) return node.map((item) => substitute(item, resolved));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, substitute(value, resolved)]));
  return node;
}

// The logic statements of `when` and `unless`.
function evaluate(condition) {
  if (condition === null || condition === undefined) return false;
  if (typeof condition === 'boolean') return condition;
  if (typeof condition === 'number') return condition !== 0;
  if (typeof condition === 'string') return condition !== '' && condition !== 'false';
  if (Array.isArray(condition)) return condition.length > 0;
  if ('and' in condition) return condition.and.every(evaluate);
  if ('or' in condition) return condition.or.some(evaluate);
  if ('not' in condition) return !evaluate(condition.not);
  if ('equal' in condition) return condition.equal.every((item) => JSON.stringify(item) === JSON.stringify(condition.equal[0]));
  if ('matches' in condition) return new RegExp(condition.matches.pattern).test(String(condition.matches.value));
  throw new Error(`'${JSON.stringify(condition)}' is not a logic statement.`);
}

// One step as the agent sees it: { type, ...its map }. A bare string is a step with no arguments.
function normaliseStep(step) {
  if (typeof step === 'string') return { type: step };
  const keys = Object.keys(step);
  if (keys.length !== 1) throw new Error(`A step must have exactly one key; this one has ${keys.join(', ')}.`);
  const [type] = keys;
  const value = step[type];
  if (type === 'run' && typeof value === 'string') return { type, command: value };
  return { type, ...(value || {}) };
}

// The steps of a step list after substitution and `when`/`unless` evaluation.
function expandSteps(steps, resolved) {
  const result = [];
  for (const raw of substitute(steps, resolved)) {
    const step = normaliseStep(raw);
    if (step.type === 'when' || step.type === 'unless') {
      const taken = evaluate(step.condition) === (step.type === 'when');
      if (taken) result.push(...expandSteps(step.steps || [], resolved));
      continue;
    }
    if (!STEP_TYPES.has(step.type)) throw new Error(`'${step.type}' is not a step the agent knows${step.type.includes('/') ? ' (orb commands are expanded before this point)' : ''}.`);
    result.push(step);
  }
  return result;
}

/**
 * The steps the agent runs for one use of a command.
 *   orb        from readOrb
 *   command    the command's name
 *   given      the parameters the step gives
 * Returns { steps, parameters }.
 */
function expandCommand(orb, command, given = {}) {
  const definition = (orb.commands || {})[command];
  if (!definition) throw new Error(`The orb has no command '${command}'.`);
  const parameters = resolveParameters(definition.parameters, given);
  return { steps: expandSteps(definition.steps || [], parameters), parameters };
}

// Problems with the orb as a whole, for what the orb validator checks that matters here.
function checkOrb(orb) {
  const problems = [];
  if (!orb.description) problems.push('the orb has no description');
  for (const [name, command] of Object.entries(orb.commands || {})) {
    problems.push(...checkParameters(command.parameters, `command ${name}`));
    if (!Array.isArray(command.steps) || command.steps.length === 0) problems.push(`command ${name} has no steps`);
  }
  for (const [name, job] of Object.entries(orb.jobs || {})) {
    problems.push(...checkParameters(job.parameters, `job ${name}`));
    if (!job.executor && !job.docker && !job.machine && !job.macos) problems.push(`job ${name} has no executor`);
    if (!Array.isArray(job.steps) || job.steps.length === 0) problems.push(`job ${name} has no steps`);
  }
  for (const [name, executor] of Object.entries(orb.executors || {})) {
    if (!executor.docker && !executor.machine && !executor.macos && !executor.windows) problems.push(`executor ${name} declares no docker, machine, macos or windows`);
  }
  for (const [name, example] of Object.entries(orb.examples || {})) {
    if (!example.usage || example.usage.version !== 2.1) problems.push(`example ${name} has no usage with version 2.1`);
  }
  return problems;
}

module.exports = { STEP_TYPES, readOrb, checkParameters, resolveParameters, substitute, evaluate, normaliseStep, expandSteps, expandCommand, checkOrb };
