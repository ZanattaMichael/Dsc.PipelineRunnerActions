# The same step from any shell that has PowerShell 7 (TeamCity, Bamboo, Buildkite, a scheduled
# task, your own machine). Settings are DSCPR_* environment variables; see docs/settings.md.
$env:DSCPR_CONFIGURATION_PATH = 'config'
$env:DSCPR_MODE = 'Test'
$env:DSCPR_MODULE_VERSION = '1.2.1'
$env:DSCPR_RESOURCE_MODULES = 'PSDscResources@2.12.0.0'

& ./.dscpr/core/Invoke-DscPipelineRunnerStep.ps1     # a checkout of Dsc.PipelineRunnerActions
exit $LASTEXITCODE
