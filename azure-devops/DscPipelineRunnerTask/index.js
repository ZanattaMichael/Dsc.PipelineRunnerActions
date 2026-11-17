'use strict';
// Azure Pipelines task entry point for Dsc.PipelineRunner.
//
// The agent passes each task input as an environment variable named INPUT_<NAME> (upper case).
// This file maps those onto the DSCPR_* variables the shared PowerShell script reads, then runs
// that script with PowerShell 7. It has no dependencies, so the extension ships no node_modules.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// [task input, environment variable for the shared script, is a secret]
const SETTINGS = [
  ['configurationPath', 'DSCPR_CONFIGURATION_PATH', false],
  ['configurationRepositoryUrl', 'DSCPR_CONFIGURATION_REPOSITORY_URL', false],
  ['configurationRevision', 'DSCPR_CONFIGURATION_REVISION', false],
  ['sourceToken', 'DSCPR_SOURCE_TOKEN', true],
  ['mode', 'DSCPR_MODE', false],
  ['engine', 'DSCPR_ENGINE', false],
  ['engineVersion', 'DSCPR_ENGINE_VERSION', false],
  ['failOnError', 'DSCPR_FAIL_ON_ERROR', false],
  ['reportPath', 'DSCPR_REPORT_PATH', false],
  ['connect', 'DSCPR_CONNECT', false],
  ['azureDevopsOrganization', 'DSCPR_AZURE_DEVOPS_ORGANIZATION', false],
  ['azureDevopsAuthentication', 'DSCPR_AZURE_DEVOPS_AUTHENTICATION', false],
  ['azureDevopsToken', 'DSCPR_AZURE_DEVOPS_TOKEN', true],
  ['moduleVersion', 'DSCPR_MODULE_VERSION', false],
  ['allowPrerelease', 'DSCPR_ALLOW_PRERELEASE', false],
  ['moduleRepository', 'DSCPR_MODULE_REPOSITORY', false],
  ['moduleSource', 'DSCPR_MODULE_SOURCE', false],
  ['moduleSourceRepository', 'DSCPR_MODULE_SOURCE_REPOSITORY', false],
  ['moduleSourceRef', 'DSCPR_MODULE_SOURCE_REF', false],
  ['resourceModules', 'DSCPR_RESOURCE_MODULES', false],
  ['skipModuleInstall', 'DSCPR_SKIP_MODULE_INSTALL', false],
  ['keepTemporaryDirectory', 'DSCPR_KEEP_TEMPORARY_DIRECTORY', false],
  ['verbose', 'DSCPR_VERBOSE', false]
];

// A value written into an agent logging command must stay on one line.
function oneLine(text) {
  return String(text).replace(/\r?\n/g, ' ');
}

function fail(message) {
  console.log(`##vso[task.logissue type=error]${oneLine(message)}`);
  console.log(`##vso[task.complete result=Failed;]${oneLine(message)}`);
  process.exitCode = 1;
}

// Maps the task inputs in `source` (the agent's environment) onto the DSCPR_* variables.
// Returns the environment for the step script and the problems found. Pure: it reads only `source`.
function buildEnvironment(source) {
  const env = { ...source, DSCPR_PLATFORM: 'azure-devops' };
  const problems = [];

  for (const [input, variable, secret] of SETTINGS) {
    const raw = source[`INPUT_${input.replace(/[ .]/g, '_').toUpperCase()}`];
    const value = raw === undefined ? '' : String(raw).trim();
    // A pipeline variable that is not defined is not replaced: the input arrives as the literal
    // text $(Name). Left alone, a missing secret would be used as if it were the secret.
    if (/^\$\([^)]+\)$/.test(value)) {
      problems.push(`Input '${input}' is ${value}, which means that pipeline variable is not defined` +
        (secret ? ' (a secret variable must be defined in the pipeline or a variable group, and is only available to the task when passed as an input like this).' : '.'));
      delete env[variable];
      continue;
    }
    if (value !== '') {
      env[variable] = value;
    } else {
      // Never let a DSCPR_* variable that happens to be set on the agent stand in for an input.
      delete env[variable];
    }
  }

  return { env, problems };
}

function main() {
  const { env, problems } = buildEnvironment(process.env);

  if (problems.length > 0) {
    for (const problem of problems) {
      console.log(`##vso[task.logissue type=error]${oneLine(problem)}`);
    }
    fail(`${problems.length} input(s) refer to pipeline variables that are not defined.`);
    return;
  }

  const script = path.join(__dirname, 'core', 'Invoke-DscPipelineRunnerStep.ps1');
  const run = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    env,
    stdio: 'inherit',
    cwd: process.env.SYSTEM_DEFAULTWORKINGDIRECTORY || process.cwd(),
  });

  if (run.error) {
    if (run.error.code === 'ENOENT') {
      fail('PowerShell 7 (pwsh) is required on the agent and was not found on PATH. Microsoft-hosted agents have it; ' +
        'install it on a self-hosted agent (https://aka.ms/powershell). See docs/requirements.md.');
    } else {
      fail(`Could not start PowerShell 7 (pwsh): ${run.error.message}`);
    }
    return;
  }

  // The script has already reported the reason and marked the task failed.
  if (run.status !== 0) {
    process.exitCode = run.status === null ? 1 : run.status;
  }
}

// Run only as the task entry point; the tests load this file to call the functions directly.
if (require.main === module) {
  main();
}

module.exports = { SETTINGS, buildEnvironment, oneLine };
