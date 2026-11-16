// Jenkins Pipeline step: dscPipelineRunner
//
// Runs Dsc.PipelineRunner on the current agent. Use inside a node / agent block:
//
//   dscPipelineRunner(configurationPath: 'config', mode: 'Test', moduleVersion: '1.2.1')
//
// Requirements: PowerShell 7 (pwsh) on the agent; the workspace checked out when
// configurationPath is used. Full list: docs/requirements.md. Every setting: docs/settings.md.
//
// Secrets: pass a Jenkins credentials ID, never the secret itself:
//   sourceTokenCredentialsId, azureDevopsTokenCredentialsId  (kind: Secret text)
// The step binds the credential to an environment variable for the duration of the run, so
// Jenkins masks it in the log.
//
// Returns a map of the outputs: status, totalResources, passCount, failCount, skipCount,
// reportPath, moduleVersion.

import groovy.transform.Field

@Field static final List SETTINGS = [
    [name: 'configurationPath', env: 'DSCPR_CONFIGURATION_PATH', secret: false],
    [name: 'configurationRepositoryUrl', env: 'DSCPR_CONFIGURATION_REPOSITORY_URL', secret: false],
    [name: 'configurationRevision', env: 'DSCPR_CONFIGURATION_REVISION', secret: false],
    [name: 'sourceToken', env: 'DSCPR_SOURCE_TOKEN', secret: true],
    [name: 'mode', env: 'DSCPR_MODE', secret: false],
    [name: 'engine', env: 'DSCPR_ENGINE', secret: false],
    [name: 'engineVersion', env: 'DSCPR_ENGINE_VERSION', secret: false],
    [name: 'failOnError', env: 'DSCPR_FAIL_ON_ERROR', secret: false],
    [name: 'reportPath', env: 'DSCPR_REPORT_PATH', secret: false],
    [name: 'connect', env: 'DSCPR_CONNECT', secret: false],
    [name: 'azureDevopsOrganization', env: 'DSCPR_AZURE_DEVOPS_ORGANIZATION', secret: false],
    [name: 'azureDevopsAuthentication', env: 'DSCPR_AZURE_DEVOPS_AUTHENTICATION', secret: false],
    [name: 'azureDevopsToken', env: 'DSCPR_AZURE_DEVOPS_TOKEN', secret: true],
    [name: 'moduleVersion', env: 'DSCPR_MODULE_VERSION', secret: false],
    [name: 'allowPrerelease', env: 'DSCPR_ALLOW_PRERELEASE', secret: false],
    [name: 'moduleRepository', env: 'DSCPR_MODULE_REPOSITORY', secret: false],
    [name: 'resourceModules', env: 'DSCPR_RESOURCE_MODULES', secret: false],
    [name: 'skipModuleInstall', env: 'DSCPR_SKIP_MODULE_INSTALL', secret: false],
    [name: 'keepTemporaryDirectory', env: 'DSCPR_KEEP_TEMPORARY_DIRECTORY', secret: false],
    [name: 'verbose', env: 'DSCPR_VERBOSE', secret: false],
]

def call(Map args = [:]) {
    def known = SETTINGS.collect { it.name } + ['sourceTokenCredentialsId', 'azureDevopsTokenCredentialsId']
    def unknown = args.keySet().findAll { !(it in known) }
    if (unknown) {
        error "dscPipelineRunner: unknown setting(s): ${unknown.join(', ')}. Known settings: ${known.join(', ')}."
    }
    if (args.sourceToken || args.azureDevopsToken) {
        error 'dscPipelineRunner: pass secrets as Jenkins credentials (sourceTokenCredentialsId, azureDevopsTokenCredentialsId), not as plain values.'
    }

    // Settings travel as environment variables, never inside the command text.
    def environment = ['DSCPR_PLATFORM=jenkins']
    SETTINGS.findAll { !it.secret }.each { setting ->
        if (args.containsKey(setting.name) && args[setting.name] != null) {
            environment << "${setting.env}=${args[setting.name]}"
        }
    }

    def bindings = []
    if (args.sourceTokenCredentialsId) {
        bindings << string(credentialsId: args.sourceTokenCredentialsId, variable: 'DSCPR_SOURCE_TOKEN')
    }
    if (args.azureDevopsTokenCredentialsId) {
        bindings << string(credentialsId: args.azureDevopsTokenCredentialsId, variable: 'DSCPR_AZURE_DEVOPS_TOKEN')
    }

    // The shared script and its settings list ship with this library.
    def stepDirectory = "${pwd(tmp: true)}/dsc-pipeline-runner"
    dir(stepDirectory) {
        writeFile file: 'Invoke-DscPipelineRunnerStep.ps1', text: libraryResource('dsc-pipeline-runner/Invoke-DscPipelineRunnerStep.ps1')
        writeFile file: 'settings.json', text: libraryResource('dsc-pipeline-runner/settings.json')
    }
    def script = "${stepDirectory}/Invoke-DscPipelineRunnerStep.ps1"
    environment << "DSCPR_STEP_SCRIPT=${script}"

    def exitCode = 0
    withEnv(environment) {
        def run = {
            if (isUnix()) {
                exitCode = sh(returnStatus: true, label: 'Dsc.PipelineRunner',
                    script: 'command -v pwsh >/dev/null 2>&1 || { echo "ERROR: PowerShell 7 (pwsh) is required on this agent and was not found on PATH. See docs/requirements.md."; exit 2; }; pwsh -NoLogo -NoProfile -NonInteractive -File "$DSCPR_STEP_SCRIPT"')
            } else {
                exitCode = bat(returnStatus: true, label: 'Dsc.PipelineRunner',
                    script: '@where pwsh >nul 2>&1 || (echo ERROR: PowerShell 7 ^(pwsh^) is required on this agent and was not found on PATH. See docs/requirements.md. & exit /b 2)\r\n@pwsh -NoLogo -NoProfile -NonInteractive -File "%DSCPR_STEP_SCRIPT%"')
            }
        }
        if (bindings) { withCredentials(bindings) { run() } } else { run() }
    }

    // Outputs: <report-path>/outputs.env, written by the shared script.
    def reportPath = args.reportPath ?: 'dsc-reports'
    def outputs = [:]
    def outputsFile = "${reportPath}/outputs.env"
    if (fileExists(outputsFile)) {
        readFile(outputsFile).split('\r?\n').each { line ->
            def separator = line.indexOf('=')
            if (separator > 0) { outputs[line.substring(0, separator)] = line.substring(separator + 1) }
        }
    }
    def result = [
        status        : outputs.DSCPR_STATUS ?: 'NotRun',
        totalResources: (outputs.DSCPR_TOTAL_RESOURCES ?: '0') as Integer,
        passCount     : (outputs.DSCPR_PASS_COUNT ?: '0') as Integer,
        failCount     : (outputs.DSCPR_FAIL_COUNT ?: '0') as Integer,
        skipCount     : (outputs.DSCPR_SKIP_COUNT ?: '0') as Integer,
        reportPath    : outputs.DSCPR_REPORT_PATH ?: reportPath,
        moduleVersion : outputs.DSCPR_MODULE_VERSION ?: ''
    ]

    if (exitCode != 0) {
        error "dscPipelineRunner: the step failed (exit code ${exitCode}, status ${result.status}). See the log above and the reports in ${result.reportPath}."
    }
    return result
}
