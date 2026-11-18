'use strict';
// A stand-in for the CircleCI build agent running the steps of one job.
//
// Given the steps CircleCI's processing produced (orb.js), it does what the agent does:
//   * runs each `run` step's command in its shell (/bin/bash -eo pipefail by default on Linux,
//     PowerShell on a Windows executor), in the working directory, with the job's environment,
//     the context's variables and the step's own `environment` on top
//   * after a step fails, runs only the steps whose `when` is always or on_fail
//   * records what store_artifacts would upload
//   * masks the values of context variables in the log, as the agent does for secrets
//
// The live tests use the CLI's local execute, which runs the real agent; see README.md.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function predefinedEnvironment(workingDirectory, jobName) {
  return {
    CI: 'true',
    CIRCLECI: 'true',
    CIRCLE_JOB: jobName,
    CIRCLE_WORKING_DIRECTORY: workingDirectory,
    CIRCLE_BUILD_NUM: '1',
    CIRCLE_NODE_INDEX: '0',
    CIRCLE_NODE_TOTAL: '1',
    CIRCLE_PROJECT_REPONAME: 'integration',
    CIRCLE_PROJECT_USERNAME: 'group',
    CIRCLE_SHA1: '0000000000000000000000000000000000000000',
    CIRCLE_BRANCH: 'main',
    CIRCLE_WORKFLOW_ID: '00000000-0000-0000-0000-000000000000',
  };
}

function findOnPath(name, pathVariable) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of pathVariable.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return name;
}

function maskSecrets(text, values) {
  let masked = text;
  // The agent masks values of at least four characters.
  for (const value of values.filter((value) => value.length >= 4).sort((a, b) => b.length - a.length)) masked = masked.split(value).join('****');
  return masked;
}

function runCommand(step, shell, env, workingDirectory, scriptDirectory, index) {
  const directory = step.working_directory ? path.resolve(workingDirectory, step.working_directory) : workingDirectory;
  let executable;
  let args;
  let header;
  if (shell === 'pwsh') {
    const scriptPath = path.join(scriptDirectory, `step-${index}.ps1`);
    fs.writeFileSync(scriptPath, `$ErrorActionPreference = 'Stop'\n${step.command}\nif ((Test-Path variable:LASTEXITCODE) -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`);
    executable = findOnPath('pwsh', process.env.PATH || '');
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath];
    header = '#!pwsh -ExecutionPolicy Bypass';
  } else {
    const scriptPath = path.join(scriptDirectory, `step-${index}.sh`);
    const shellLine = step.shell || '/bin/bash -eo pipefail';
    fs.writeFileSync(scriptPath, `#!${shellLine}\n${step.command}\n`, { mode: 0o755 });
    const [program, ...options] = shellLine.split(/\s+/);
    executable = program;
    args = [...options, scriptPath];
    header = `#!${shellLine}`;
  }
  const run = spawnSync(executable, args, { env, cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let output = `${header}\n${step.command}\n${run.stdout || ''}${run.stderr || ''}`;
  let exitCode = run.status === null ? 1 : run.status;
  if (run.error) { output += `\nError: could not start ${executable}: ${run.error.message}\n`; exitCode = 1; }
  if (exitCode !== 0) output += `\nExited with code exit status ${exitCode}\nCircleCI received exit code ${exitCode}\n`;
  return { output, exitCode };
}

/**
 * Runs the steps of a job.
 *   steps              from orb.expandCommand (already expanded)
 *   workingDirectory   the job's working directory (the checkout)
 *   jobName            CIRCLE_JOB
 *   environment        the job's `environment` map
 *   context            variables from a context (secrets)
 *   machine            the executor's own environment (PATH and so on)
 *   shell              'bash' or 'pwsh'; default by platform
 */
function runSteps({ steps, workingDirectory, jobName = 'build', environment = {}, context = {}, machine = process.env, shell }) {
  const chosenShell = shell || (process.platform === 'win32' ? 'pwsh' : 'bash');
  const scriptDirectory = path.join(workingDirectory, '..', 'steps');
  fs.mkdirSync(scriptDirectory, { recursive: true });
  const jobEnvironment = { ...machine, ...predefinedEnvironment(workingDirectory, jobName), ...context, ...environment };
  const log = [];
  const results = [];
  let failed = false;

  steps.forEach((step, index) => {
    const when = step.when || 'on_success';
    const runs = when === 'always' || (when === 'on_success' && !failed) || (when === 'on_fail' && failed);
    const record = { type: step.type, name: step.name || step.type, when, ran: runs };
    if (!runs) { results.push(record); return; }
    if (step.type === 'run') {
      const env = { ...jobEnvironment, ...Object.fromEntries(Object.entries(step.environment || {}).map(([key, value]) => [key, String(value)])) };
      const { output, exitCode } = runCommand(step, chosenShell, env, workingDirectory, scriptDirectory, index);
      log.push(`---- ${record.name}`, output);
      record.exitCode = exitCode;
      if (exitCode !== 0) failed = true;
    } else if (step.type === 'store_artifacts') {
      const absolute = path.resolve(workingDirectory, step.path);
      record.path = step.path;
      record.destination = step.destination;
      record.exists = fs.existsSync(absolute);
      log.push(`---- Uploading artifacts`, record.exists ? `Uploading ${step.path} to ${step.destination || step.path}` : `Warning: ${step.path} does not exist; nothing uploaded`);
    } else {
      log.push(`---- ${record.name}`, `(${step.type}: not run by the stand-in)`);
    }
    results.push(record);
  });

  const raw = log.join('\n');
  return { status: failed ? 'failed' : 'success', steps: results, raw, log: maskSecrets(raw, Object.values(context).map(String)), shell: chosenShell };
}

module.exports = { predefinedEnvironment, findOnPath, maskSecrets, runSteps };
