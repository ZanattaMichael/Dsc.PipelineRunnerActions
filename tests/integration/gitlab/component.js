'use strict';
// A stand-in for what GitLab does with a CI/CD component before a runner sees the job.
//
// GitLab cannot be started without a GitLab server, so this file does what the server does
// between "a pipeline includes the component" and "a runner is given the job":
//
//   * reads the component template: a spec document (its inputs) and the template document
//   * resolves the include's inputs against the spec: defaults, required inputs, options, types
//   * interpolates $[[ inputs.name ]] into the template, in keys and values, as the server does
//     (a value that is only an input reference keeps the input's type, so an array input can be
//     a list of runner tags)
//   * merges the job with the pipeline's own job of the same name, the way included
//     configuration is merged with the local file (deep merge of maps; a list is replaced)
//   * checks the job against what the pipeline editor accepts, for the keywords the template uses
//   * expands $VARIABLE references in the job's variables
//   * reads an artifacts:reports:dotenv file with the rules the server applies to it
//
// The live tests (live/) run the same cases on a real GitLab server; see README.md in this folder.

const fs = require('node:fs');
const YAML = require('yaml');
const yaml = { parseAll: (text) => YAML.parseAllDocuments(text).map((document) => { if (document.errors.length) throw new Error(document.errors[0].message); return document.toJS(); }) };

const ACCESS = /\$\[\[\s*inputs\.([A-Za-z0-9_-]+)\s*((?:\|[^\]]*)?)\]\]/g;
const JOB_KEYWORDS = new Set(['after_script', 'allow_failure', 'artifacts', 'before_script', 'cache', 'coverage', 'dast_configuration',
  'dependencies', 'environment', 'extends', 'hooks', 'id_tokens', 'identity', 'image', 'inherit', 'interruptible', 'manual_confirmation',
  'needs', 'pages', 'parallel', 'release', 'resource_group', 'retry', 'rules', 'run', 'script', 'secrets', 'services', 'stage', 'tags',
  'timeout', 'trigger', 'variables', 'when']);
const RESERVED_NAMES = new Set(['image', 'services', 'stages', 'types', 'before_script', 'after_script', 'variables', 'cache', 'include', 'true', 'false', 'nil', 'default', 'workflow', 'spec']);

// ---- The template -----------------------------------------------------------------------------

function readTemplate(path) {
  const documents = yaml.parseAll(fs.readFileSync(path, 'utf8'));
  if (documents.length !== 2) throw new Error(`${path}: a component template holds two YAML documents (the spec and the template), not ${documents.length}.`);
  const [header, template] = documents;
  if (!header || typeof header !== 'object' || !header.spec) throw new Error(`${path}: the first document must be the spec.`);
  const spec = header.spec;
  if (Object.keys(header).length !== 1) throw new Error(`${path}: the spec document may only hold 'spec'.`);
  return { spec, inputs: spec.inputs || {}, template };
}

const INPUT_KEYS = new Set(['default', 'description', 'options', 'regex', 'rules', 'type']);
const INPUT_TYPES = new Set(['string', 'number', 'boolean', 'array']);

// Problems the server reports about a spec, independent of any include.
function checkSpec(inputs) {
  const problems = [];
  for (const [name, input] of Object.entries(inputs)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) problems.push(`input '${name}': names may only hold letters, digits, _ and -`);
    if (input === null || input === undefined) continue;
    if (typeof input !== 'object') { problems.push(`input '${name}' is not a map`); continue; }
    for (const key of Object.keys(input)) if (!INPUT_KEYS.has(key)) problems.push(`input '${name}': '${key}' is not a spec keyword`);
    const type = input.type || 'string';
    if (!INPUT_TYPES.has(type)) problems.push(`input '${name}': type '${type}' is not one of ${[...INPUT_TYPES].join(', ')}`);
    if (input.options !== undefined) {
      if (!Array.isArray(input.options) || input.options.length === 0) problems.push(`input '${name}': options must be a non-empty list`);
      else if (type !== 'string' && type !== 'number') problems.push(`input '${name}': options are only allowed for string and number inputs`);
      else if (input.default !== undefined && !input.options.some((option) => String(option) === String(input.default))) problems.push(`input '${name}': the default '${input.default}' is not one of the options`);
      if (input.regex !== undefined) problems.push(`input '${name}': regex and options cannot be used together`);
    }
    if (input.regex !== undefined && type !== 'string') problems.push(`input '${name}': regex is only allowed for string inputs`);
    if (input.default !== undefined && !valueHasType(input.default, type)) problems.push(`input '${name}': the default is not a ${type}`);
  }
  return problems;
}

function valueHasType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    default: return false;
  }
}

// The inputs the include supplies, resolved against the spec. Throws with every problem at once.
function resolveInputs(inputs, given) {
  const problems = [];
  const resolved = {};
  for (const name of Object.keys(given)) {
    if (!(name in inputs)) problems.push(`'${name}' is not an input of the component`);
  }
  for (const [name, declared] of Object.entries(inputs)) {
    const input = declared || {};
    const type = input.type || 'string';
    let value;
    if (name in given) value = given[name];
    else if ('default' in input) value = input.default;
    else { problems.push(`'${name}' is required (it has no default) and was not given`); continue; }
    if (!valueHasType(value, type)) { problems.push(`'${name}' must be a ${type}; '${JSON.stringify(value)}' is not`); continue; }
    if (input.options && !input.options.some((option) => String(option) === String(value))) problems.push(`'${name}' is '${value}', which is not one of its options: ${input.options.join(', ')}`);
    if (input.regex !== undefined && !new RegExp(input.regex).test(value)) problems.push(`'${name}' is '${value}', which does not match ${input.regex}`);
    resolved[name] = value;
  }
  if (problems.length > 0) throw new Error(`The component's inputs are not valid:\n  ${problems.join('\n  ')}`);
  return resolved;
}

// The functions GitLab allows after an input reference. Only the ones the templates need.
function applyFunctions(value, functions) {
  let result = value;
  for (const call of functions.split('|').map((text) => text.trim()).filter(Boolean)) {
    const match = /^([a-z_]+)(?:\(([^)]*)\))?$/.exec(call);
    if (!match) throw new Error(`'${call}' is not an interpolation function.`);
    if (match[1] === 'expand_vars') {
      result = String(result).replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (text) => text);
    } else if (match[1] === 'truncate') {
      const [offset, length] = (match[2] || '').split(',').map((part) => Number(part.trim()));
      result = String(result).slice(offset, offset + length);
    } else {
      throw new Error(`'${match[1]}' is not an interpolation function.`);
    }
  }
  return result;
}

// Replaces every $[[ inputs.name ]] in a string. A string that is one reference and nothing else
// becomes the input's own value, whatever its type.
function interpolateString(text, resolved) {
  const whole = /^\s*\$\[\[\s*inputs\.([A-Za-z0-9_-]+)\s*((?:\|[^\]]*)?)\]\]\s*$/.exec(text);
  if (whole) {
    if (!(whole[1] in resolved)) throw new Error(`'${text}' refers to input '${whole[1]}', which the component does not declare.`);
    return applyFunctions(resolved[whole[1]], whole[2]);
  }
  return text.replace(ACCESS, (match, name, functions) => {
    if (!(name in resolved)) throw new Error(`'${match}' refers to input '${name}', which the component does not declare.`);
    const value = applyFunctions(resolved[name], functions);
    if (Array.isArray(value)) throw new Error(`'${match}': an array input can only be used on its own, not inside a string.`);
    return String(value);
  });
}

function interpolate(node, resolved) {
  if (typeof node === 'string') return interpolateString(node, resolved);
  if (Array.isArray(node)) return node.map((item) => interpolate(item, resolved));
  if (node && typeof node === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(node)) result[String(interpolateString(key, resolved))] = interpolate(value, resolved);
    return result;
  }
  return node;
}

// ---- The pipeline -----------------------------------------------------------------------------

// What GitLab does when the local file defines the same key as an included file: maps are merged
// key by key, with the local value winning; anything else is replaced by the local value.
function mergeJob(included, local) {
  if (local === undefined) return included;
  if (included && typeof included === 'object' && !Array.isArray(included) && local && typeof local === 'object' && !Array.isArray(local)) {
    const result = { ...included };
    for (const [key, value] of Object.entries(local)) result[key] = mergeJob(included[key], value);
    return result;
  }
  return local;
}

// Problems the pipeline editor would report for one job, for the keywords the templates use.
function checkJob(name, job, stages) {
  const problems = [];
  if (RESERVED_NAMES.has(name)) problems.push(`'${name}' is a reserved keyword and cannot be a job name`);
  if (!job || typeof job !== 'object' || Array.isArray(job)) return [`job '${name}' is not a map`];
  for (const key of Object.keys(job)) if (!JOB_KEYWORDS.has(key)) problems.push(`job '${name}': '${key}' is not a job keyword`);
  if (!job.script && !job.trigger && !job.run) problems.push(`job '${name}' has no script`);
  if (job.script !== undefined && !(typeof job.script === 'string' || (Array.isArray(job.script) && job.script.every((line) => typeof line === 'string' || Array.isArray(line))))) {
    problems.push(`job '${name}': script must be a string or a list of strings`);
  }
  if (job.stage !== undefined) {
    if (typeof job.stage !== 'string') problems.push(`job '${name}': stage must be a string`);
    else if (!stages.includes(job.stage) && job.stage !== '.pre' && job.stage !== '.post') problems.push(`job '${name}': stage '${job.stage}' is not in the pipeline's stages (${stages.join(', ')})`);
  }
  if (job.image !== undefined && typeof job.image !== 'string' && !(job.image && typeof job.image === 'object' && typeof job.image.name === 'string')) problems.push(`job '${name}': image must be a string or a map with a name`);
  if (job.tags !== undefined && !(Array.isArray(job.tags) && job.tags.every((tag) => typeof tag === 'string'))) problems.push(`job '${name}': tags must be a list of strings`);
  if (job.variables !== undefined) {
    if (!job.variables || typeof job.variables !== 'object' || Array.isArray(job.variables)) problems.push(`job '${name}': variables must be a map`);
    else {
      for (const [variable, value] of Object.entries(job.variables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) problems.push(`job '${name}': '${variable}' is not a valid variable name`);
        if (!['string', 'number', 'boolean'].includes(typeof value) && !(value && typeof value === 'object' && 'value' in value)) problems.push(`job '${name}': variable '${variable}' must be a string, number or boolean`);
      }
    }
  }
  if (job.artifacts !== undefined) {
    const artifacts = job.artifacts;
    if (!artifacts || typeof artifacts !== 'object') problems.push(`job '${name}': artifacts must be a map`);
    else {
      for (const key of Object.keys(artifacts)) if (!['paths', 'exclude', 'expire_in', 'expose_as', 'name', 'public', 'access', 'reports', 'untracked', 'when'].includes(key)) problems.push(`job '${name}': artifacts:${key} is not a keyword`);
      if (artifacts.paths !== undefined && !(Array.isArray(artifacts.paths) && artifacts.paths.every((item) => typeof item === 'string' && item !== ''))) problems.push(`job '${name}': artifacts:paths must be a list of non-empty strings`);
      if (artifacts.when !== undefined && !['on_success', 'on_failure', 'always'].includes(artifacts.when)) problems.push(`job '${name}': artifacts:when '${artifacts.when}' is not on_success, on_failure or always`);
      if (artifacts.reports !== undefined) {
        if (!artifacts.reports || typeof artifacts.reports !== 'object') problems.push(`job '${name}': artifacts:reports must be a map`);
        else if (artifacts.reports.dotenv !== undefined && typeof artifacts.reports.dotenv !== 'string' && !Array.isArray(artifacts.reports.dotenv)) problems.push(`job '${name}': artifacts:reports:dotenv must be a path`);
      }
    }
  }
  return problems;
}

// $VAR and ${VAR} in a job's variables, expanded from the other variables, as the server does.
function expandVariables(variables) {
  const result = { ...variables };
  const lookup = (name) => (name in result ? String(result[name]) : undefined);
  for (let pass = 0; pass < 10; pass += 1) {
    let changed = false;
    for (const [name, value] of Object.entries(result)) {
      if (typeof value !== 'string') continue;
      const expanded = value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (text, plain, braced) => {
        const found = lookup(plain || braced);
        return found === undefined ? text : found;
      });
      if (expanded !== value) { result[name] = expanded; changed = true; }
    }
    if (!changed) break;
  }
  return result;
}

/**
 * The job a pipeline gets from the component, as the server builds it:
 *   template      from readTemplate
 *   given         the inputs the include supplies
 *   localJobs     the pipeline's own jobs (a job of the same name is merged on top)
 *   stages        the pipeline's stages
 * Returns { name, job, problems }.
 */
function buildJob(template, given, localJobs = {}, stages = ['build', 'test', 'deploy']) {
  const resolved = resolveInputs(template.inputs, given);
  const rendered = interpolate(template.template, resolved);
  const names = Object.keys(rendered);
  if (names.length !== 1) throw new Error(`The template defines ${names.length} jobs; expected one.`);
  const name = names[0];
  const job = mergeJob(rendered[name], localJobs[name]);
  const problems = checkJob(name, job, stages);
  return { name, job, problems, inputs: resolved };
}

// ---- dotenv reports ---------------------------------------------------------------------------

// Reads an artifacts:reports:dotenv file the way the server does when the artifact is uploaded.
// Returns { variables, problems }: a problem makes the job fail at upload.
function parseDotenv(text, limit = 20) {
  const variables = {};
  const problems = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const match = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (!match) { problems.push(`line ${index + 1} is not KEY=VALUE: ${line}`); return; }
    const [, key, raw] = match;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) problems.push(`line ${index + 1}: '${key}' is not a valid variable name`);
    let value = raw.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    if (value.length > 5 * 1024) problems.push(`line ${index + 1}: the value of '${key}' is longer than 5 KB`);
    variables[key] = value;
  });
  if (Object.keys(variables).length > limit) problems.push(`the file sets ${Object.keys(variables).length} variables; the limit is ${limit}`);
  return { variables, problems };
}

module.exports = { readTemplate, checkSpec, resolveInputs, interpolate, mergeJob, checkJob, expandVariables, buildJob, parseDotenv };
