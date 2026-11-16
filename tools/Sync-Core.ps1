#requires -Version 7.0
<#
.SYNOPSIS
Copies core/ to the places that need their own copy of it.

.DESCRIPTION
core/ is the one source of the shared step script and the settings list. Two integrations cannot
read it from there:

  * Jenkins loads library files only from <library>/resources/, so jenkins/resources/dsc-pipeline-runner/
    holds a copy that is committed. A test fails when it differs from core/.
  * An Azure DevOps task can only use files inside its own folder, so the task folder gets a copy
    when the extension is packaged (-AzureDevOps). That copy is not committed.

Run this after changing anything in core/.
#>
[CmdletBinding()]
param(
    # Also copy core/ into the Azure DevOps task folder (done by the packaging pipeline).
    [switch] $AzureDevOps
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$files = 'Invoke-DscPipelineRunnerStep.ps1', 'settings.json'

$targets = @(Join-Path $root 'jenkins/resources/dsc-pipeline-runner')
if ($AzureDevOps) { $targets += Join-Path $root 'azure-devops/DscPipelineRunnerTask/core' }

foreach ($target in $targets) {
    $null = New-Item -ItemType Directory -Path $target -Force
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $root "core/$file") -Destination (Join-Path $target $file) -Force
    }
    Write-Host "Copied core/ to $target"
}
