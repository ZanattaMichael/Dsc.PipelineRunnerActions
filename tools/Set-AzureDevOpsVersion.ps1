#requires -Version 7.0
<#
.SYNOPSIS
Stamps a version into the Azure DevOps task and extension manifest before packaging.

.DESCRIPTION
The repository keeps 0.0.0 in azure-devops/DscPipelineRunnerTask/task.json and
azure-devops/vss-extension.json; the packaging pipeline writes the release version into both, so
the task version, the extension version and the Git tag always agree. Optionally sets the
publisher and whether the extension is public.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('\A\d+\.\d+\.\d+\z')]
    [string] $Version,

    [ValidatePattern('\A[A-Za-z0-9][A-Za-z0-9-]*\z')]
    [string] $Publisher,

    [switch] $Public
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$major, $minor, $patch = $Version -split '\.' | ForEach-Object { [int]$_ }

$taskPath = Join-Path $root 'azure-devops/DscPipelineRunnerTask/task.json'
$task = Get-Content -LiteralPath $taskPath -Raw | ConvertFrom-Json
$task.version.Major = $major
$task.version.Minor = $minor
$task.version.Patch = $patch
$task | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $taskPath -Encoding utf8

$manifestPath = Join-Path $root 'azure-devops/vss-extension.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifest.version = $Version
if ($Publisher) { $manifest.publisher = $Publisher }
$manifest.public = [bool]$Public
$manifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host ("Azure DevOps task and extension set to {0} (publisher {1}, public {2})." -f $Version, $manifest.publisher, $manifest.public)
