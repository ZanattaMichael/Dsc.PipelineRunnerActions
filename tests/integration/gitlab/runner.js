'use strict';
// A stand-in for a GitLab Runner shell executor running one job.
//
// Given the job the server built (component.js), it does what the runner does:
//   * puts the job's variables, the pipeline's variables and the predefined CI_* variables in the
//     environment (expanded the way the server expands them)
//   * runs the script lines in one shell session that stops at the first failing line, echoing
//     each line as the runner does; bash on Linux and macOS, PowerShell 7 on Windows
//   * collects the artifacts after the script, whatever the exit code when artifacts:when is
//     always, and reads the dotenv report with the server's rules
//   * masks the pipeline's masked variables in the log, as the runner does
//
// The job runs in a directory that stands for the project checkout (CI_PROJECT_DIR).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { expandVariables, parseDotenv } = require('./component.js');

function predefinedVariables(projectDirectory, jobName, job) {
  return {
    CI: 'true',
    GITLAB_CI: 'true',
    CI_PROJECT_DIR: projectDirectory,
    CI_PROJECT_NAME: 'integration',
    CI_PROJECT_PATH: 'group/integration',
    CI_PROJECT_ID: '1',
    CI_JOB_NAME: jobName,
    CI_JOB_STAGE: job.stage || 'test',
    CI_JOB_ID: '1',
    CI_PIPELINE_ID: '1',
    CI_PIPELINE_SOURCE: 'push',
    CI_COMMIT_SHA: '0000000000000000000000000000000000000000',
    CI_COMMIT_REF_NAME: 'main',
    CI_COMMIT_BRANCH: 'main',
    CI_SERVER_URL: 'https://gitlab.example.test',
    CI_SERVER_HOST: 'gitlab.example.test',
    CI_SERVER_FQDN: 'gitlab.example.test',
    CI_API_V4_URL: 'https://gitlab.example.test/api/v4',
    CI_RUNNER_EXECUTABLE_ARCH: process.platform === 'win32' ? 'windows/amd64' : 'linux/amd64',
  };
}

function scriptLines(script) {
  const lines = Array.isArray(script) ? script : [script];
  return lines.flatMap((line) => (Array.isArray(line) ? line : [line])).map(String);
}

// The script the runner writes for the job's shell.
function buildShellScript(shell, lines) {
  if (shell === 'pwsh') {
    // The PowerShell shell writes each line, runs it, and stops at a failing command or a
    // non-zero exit code of a native command.
    const body = lines.map((line) => [
      `Write-Host ('$ ' + ${JSON.stringify(line)})`,
      line,
      'if ((Test-Path variable:LASTEXITCODE) -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    ].join('\n'));
    return ['$ErrorActionPreference = "Stop"', ...body].join('\n') + '\n';
  }
  const body = lines.map((line) => `echo ${bashQuote(`$ ${line}`)}\n${line}`);
  return ['set -eo pipefail', 'set +o noclobber', ...body].join('\n') + '\n';
}

function bashQuote(text) {
  return `'${String(text).replaceAll("'", "'\\''")}'`;
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

function maskVariables(text, values) {
  let masked = text;
  for (const value of values.filter((value) => value !== '').sort((a, b) => b.length - a.length)) masked = masked.split(value).join('[MASKED]');
  return masked;
}

// Finds the files an artifacts:paths entry names, relative to the project directory. Globs are
// limited to what the templates use: a plain path, or one with * in the last part.
function collectArtifactPaths(projectDirectory, patterns) {
  const found = [];
  for (const pattern of patterns) {
    const absolute = path.join(projectDirectory, pattern);
    if (fs.existsSync(absolute)) { found.push(pattern); continue; }
    const directory = path.dirname(absolute);
    const name = path.basename(pattern);
    if (name.includes('*') && fs.existsSync(directory)) {
      const regex = new RegExp(`^${name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      for (const entry of fs.readdirSync(directory)) if (regex.test(entry)) found.push(path.join(path.dirname(pattern), entry));
    }
  }
  return found;
}

/**
 * Runs one job.
 *   name, job          from component.buildJob
 *   projectDirectory   the checkout the job runs in
 *   variables          the pipeline's CI/CD variables (project or group level)
 *   masked             names of the variables that are masked
 *   environment        the runner machine's own environment (PATH and so on)
 *   shell              'bash' or 'pwsh'; default by platform
 */
// Runs a command without blocking the event loop: the job fetches the step script from a web
// server that lives in this very process, so a synchronous spawn would wait for ever.
function run(command, args, options) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, options);
    } catch (error) {
      resolve({ status: null, stdout, stderr, error });
      return;
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ status: null, stdout, stderr, error }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function runJob({ name, job, projectDirectory, variables = {}, masked = [], environment = process.env, shell }) {
  const chosenShell = shell || (process.platform === 'win32' ? 'pwsh' : 'bash');
  const jobVariables = {};
  for (const [variable, value] of Object.entries(job.variables || {})) jobVariables[variable] = value && typeof value === 'object' ? String(value.value) : String(value);
  // Precedence, lowest first: predefined, pipeline (project) variables, job variables.
  const all = expandVariables({ ...predefinedVariables(projectDirectory, name, job), ...variables, ...jobVariables });
  const env = { ...environment, ...all };

  const lines = scriptLines(job.script || []);
  const script = buildShellScript(chosenShell, lines);
  const scriptPath = path.join(projectDirectory, '..', `job-${name}.${chosenShell === 'pwsh' ? 'ps1' : 'sh'}`);
  fs.writeFileSync(scriptPath, script);
  // The job shell is found on the runner's own PATH, not the job's: a job may hide pwsh from
  // its PATH without losing the shell that runs it.
  const executable = findOnPath(chosenShell === 'pwsh' ? 'pwsh' : 'bash', process.env.PATH || '');
  const command = chosenShell === 'pwsh' ? [executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath]] : [executable, [scriptPath]];
  const result = await run(command[0], command[1], { env, cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  let raw = `${result.stdout || ''}${result.stderr || ''}`;
  let exitCode = result.status === null ? 1 : result.status;
  if (result.error) { raw += `\nERROR: Could not start the job shell ${command[0]}: ${result.error.message}\n`; exitCode = 1; }

  // Artifacts, as the runner collects them after the script.
  const artifacts = job.artifacts || {};
  const when = artifacts.when || 'on_success';
  const collect = when === 'always' || (when === 'on_success' && exitCode === 0) || (when === 'on_failure' && exitCode !== 0);
  const collected = collect ? collectArtifactPaths(projectDirectory, artifacts.paths || []) : [];
  const missing = collect ? (artifacts.paths || []).filter((pattern) => !collected.some((found) => found === pattern || found.startsWith(`${path.dirname(pattern)}${path.sep}`) || path.dirname(found) === path.dirname(pattern))) : [];
  let dotenv = { variables: {}, problems: [], found: false };
  const report = artifacts.reports && artifacts.reports.dotenv;
  if (collect && report) {
    const reportPath = path.join(projectDirectory, Array.isArray(report) ? report[0] : report);
    if (fs.existsSync(reportPath)) dotenv = { ...parseDotenv(fs.readFileSync(reportPath, 'utf8')), found: true };
  }
  if (dotenv.problems.length > 0) raw += `\nERROR: Uploading artifacts as "dotenv" to coordinator... failed: ${dotenv.problems.join('; ')}\n`;
  for (const pattern of missing) raw += `\nWARNING: ${pattern}: no matching files. Ensure that the artifact path is relative to the working directory\n`;

  const status = exitCode === 0 && dotenv.problems.length === 0 ? 'success' : 'failed';
  const maskedValues = masked.map((variable) => all[variable]).filter((value) => value !== undefined);
  return { status, exitCode, raw, log: maskVariables(raw, maskedValues), shell: chosenShell, environment: all, artifacts: collected, missingArtifacts: missing, dotenv };
}

module.exports = { predefinedVariables, scriptLines, buildShellScript, collectArtifactPaths, findOnPath, maskVariables, runJob };
