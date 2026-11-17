#requires -Version 7.0
<#
.SYNOPSIS
Runs Dsc.PipelineRunner as one step of a CI/CD pipeline. Shared by every integration in this
repository (GitHub Action, Azure DevOps task, GitLab component, CircleCI orb, Jenkins step).

.DESCRIPTION
Each integration is a thin wrapper that maps its platform's inputs onto DSCPR_* environment
variables and then runs this script. Doing the work in one place keeps the integrations
identical in behaviour.

The script, in order:

  1. Reads the settings (core/settings.json lists them) from DSCPR_* environment variables.
  2. Validates them and checks what the agent needs (PowerShell 7, git, the dsc engine ...).
     EVERY problem is reported in one pass, so a first run shows the whole list of what is
     missing rather than one item at a time.
  3. Prints the requirements and the effective settings. Secrets are shown as set / not set.
  4. Installs Dsc.PipelineRunner and the resource modules (unless told not to).
  5. Runs Invoke-DscRunner.
  6. Writes result.json and outputs.env to the report directory, publishes the outputs in the
     platform's own format, and exits non-zero when the run failed and fail-on-error is true.

Settings are read from the environment, never from the command line: a value is then never
interpolated into a script, and a secret is never visible in a process listing.

.PARAMETER Setting
Overrides for testing: a hashtable keyed by setting name (for example @{ mode = 'Set' }).
A key here wins over the environment variable.

.PARAMETER Platform
github, azure-devops, gitlab, circleci, jenkins or generic. Decides how outputs, log groups and
error annotations are written. Default: DSCPR_PLATFORM, otherwise detected from the environment.

.PARAMETER PreflightOnly
Validate, print the requirements and settings, and stop. Nothing is installed or run.

.OUTPUTS
[pscustomobject] The step result (also written to <report-path>/result.json).
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'NoExit', Justification = 'Read by the nested Exit-Step function.')]
[CmdletBinding()]
param(
    [hashtable] $Setting = @{},

    [ValidateSet('', 'github', 'azure-devops', 'gitlab', 'circleci', 'jenkins', 'generic')]
    [string] $Platform = '',

    [switch] $PreflightOnly,

    # Return instead of calling exit (tests).
    [switch] $NoExit
)

# No Set-StrictMode here on purpose: a module's ScriptsToProcess runs in the importing scope and
# would inherit it, and modules this step loads are not all written for strict mode.
$ErrorActionPreference = 'Stop'

#region platform -------------------------------------------------------------------------------

if (-not $Platform) { $Platform = [string]$env:DSCPR_PLATFORM }
if (-not $Platform) {
    $Platform = if ($env:GITHUB_ACTIONS -eq 'true') { 'github' }
    elseif ($env:TF_BUILD) { 'azure-devops' }
    elseif ($env:GITLAB_CI) { 'gitlab' }
    elseif ($env:CIRCLECI) { 'circleci' }
    elseif ($env:JENKINS_URL) { 'jenkins' }
    else { 'generic' }
}

# A value written into a platform logging command must stay on one line and must not be able to
# start a command of its own.
function ConvertTo-SingleLine {
    param([AllowNull()][string] $Text)
    if ($null -eq $Text) { return '' }
    return (($Text -replace '\r?\n', ' ') -replace '::', ': :' -replace '##vso\[', '## vso[' -replace '##\[', '## [')
}

function Write-StepGroup {
    param([string] $Title, [switch] $End)
    switch ($Platform) {
        'github' { if ($End) { Write-Host '::endgroup::' } else { Write-Host "::group::$Title" } }
        'azure-devops' { if ($End) { Write-Host '##[endgroup]' } else { Write-Host "##[group]$Title" } }
        default { if (-not $End) { Write-Host ''; Write-Host "== $Title" } }
    }
}

function Write-StepProblem {
    param([string] $Message, [ValidateSet('error', 'warning')] [string] $Level = 'error')
    $line = ConvertTo-SingleLine $Message
    switch ($Platform) {
        'github' { Write-Host "::${Level}::$line" }
        'azure-devops' { Write-Host "##vso[task.logissue type=$Level]$line" }
        default { Write-Host ("{0}: {1}" -f $Level.ToUpperInvariant(), $line) }
    }
}

# A plain fixed-width table. Format-Table truncates to the console width, which on a CI agent is
# often 80 columns or unknown; these tables must always be readable in full.
function Write-StepTable {
    param([object[]] $Row, [string[]] $Column)
    $widths = foreach ($name in $Column) {
        [Math]::Max($name.Length, [int](($Row | ForEach-Object { ([string]$_.$name).Length } | Measure-Object -Maximum).Maximum))
    }
    $format = (0..($Column.Count - 1) | ForEach-Object { "{$_,-$($widths[$_])}" }) -join '  '
    $header = ($format -f $Column).TrimEnd(); Write-Host $header
    Write-Host (($widths | ForEach-Object { '-' * $_ }) -join '  ')
    foreach ($item in $Row) {
        $values = foreach ($name in $Column) { [string]$item.$name }
        $line = [string]::Format($format, [object[]]$values).TrimEnd(); Write-Host $line
    }
}

function Exit-Step {
    param([int] $Code, $Result)
    if ($Platform -eq 'azure-devops' -and $Code -ne 0) { Write-Host '##vso[task.complete result=Failed;]' }
    if ($NoExit) { return $Result }
    exit $Code
}

#endregion

#region settings -------------------------------------------------------------------------------

$definitionPath = Join-Path $PSScriptRoot 'settings.json'
$definition = Get-Content -LiteralPath $definitionPath -Raw | ConvertFrom-Json

$settings = [ordered]@{}
foreach ($item in $definition.settings) {
    $value = $null
    if ($Setting.ContainsKey($item.name)) { $value = [string]$Setting[$item.name] }
    else { $value = [System.Environment]::GetEnvironmentVariable($item.env) }
    if ([string]::IsNullOrWhiteSpace($value)) { $value = [string]$item.default }
    $settings[$item.name] = $value.Trim()
}

$problems = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()
$requirements = [System.Collections.Generic.List[object]]::new()

function Add-Requirement {
    param([string] $Name, [bool] $Met, [string] $Detail)
    $requirements.Add([pscustomobject]@{ Requirement = $Name; Status = if ($Met) { 'OK' } else { 'MISSING' }; Detail = $Detail })
}

# Fixed-value settings: accept any letter case, store the canonical spelling.
foreach ($item in $definition.settings) {
    if (-not $item.PSObject.Properties['values']) { continue }
    $match = @($item.values | Where-Object { $_ -ieq $settings[$item.name] })
    if ($match.Count -eq 1) { $settings[$item.name] = [string]$match[0] }
    else { $problems.Add("'$($item.name)' is '$($settings[$item.name])'. Allowed values: $($item.values -join ', ').") }
}

function Test-Flag { param([string] $Name) return ($settings[$Name] -ieq 'true') }

$mode = $settings['mode']
$engine = $settings['engine']
$connect = $settings['connect']
$hasPath = -not [string]::IsNullOrWhiteSpace($settings['configuration-path'])
$hasUrl = -not [string]::IsNullOrWhiteSpace($settings['configuration-repository-url'])

#endregion

#region preflight ------------------------------------------------------------------------------

Add-Requirement 'PowerShell 7.0 or later' $true "PowerShell $($PSVersionTable.PSVersion) on $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"

# Configuration source: exactly one of the two.
$configurationPath = $null
if ($hasPath -and $hasUrl) {
    $problems.Add("Both 'configuration-path' and 'configuration-repository-url' are set. Set one: a directory in the workspace, or a Git repository to clone.")
}
elseif (-not $hasPath -and -not $hasUrl) {
    $problems.Add("No configuration source. Set 'configuration-path' (a directory in the workspace that contains Datum.yml) or 'configuration-repository-url' (a Git repository to clone).")
}
elseif ($hasPath) {
    $configurationPath = [System.IO.Path]::GetFullPath($settings['configuration-path'], (Get-Location).Path)
    $exists = Test-Path -LiteralPath $configurationPath -PathType Container
    Add-Requirement 'Configuration directory exists' $exists $configurationPath
    if (-not $exists) {
        $problems.Add("'configuration-path' does not exist or is not a directory: $configurationPath. Has the repository been checked out before this step?")
    }
}
else {
    $git = Get-Command -Name git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    Add-Requirement 'git (to clone the configuration repository)' ($null -ne $git) $(if ($git) { $git.Source } else { 'not found on PATH' })
    if (-not $git) { $problems.Add("'configuration-repository-url' is set but git is not installed on the agent (not found on PATH).") }
    if ($settings['configuration-repository-url'] -match '^[a-z][a-z0-9+.-]*://[^/@]*:[^/@]*@') {
        $problems.Add("'configuration-repository-url' contains a password or token. Remove it from the URL and supply it as 'source-token' from the secret store.")
    }
    if (-not $settings['configuration-revision']) {
        $warnings.Add("'configuration-revision' is empty, so the default branch's newest commit is used. Pin a full commit SHA for a reproducible, verified run.")
    }
}
if ($hasPath -and ($settings['configuration-revision'] -or $settings['source-token'])) {
    $warnings.Add("'configuration-revision' and 'source-token' only apply with 'configuration-repository-url'; they are ignored for 'configuration-path'.")
}

# Engine.
if ($engine -eq 'DscV3') {
    $dsc = Get-Command -Name dsc -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $needed = $mode -ne 'DryRun'
    Add-Requirement 'dsc command-line engine (DSC v3)' (($null -ne $dsc) -or -not $needed) $(
        if ($dsc) { $dsc.Source } elseif ($needed) { 'not found on PATH' } else { 'not found on PATH (not needed for DryRun)' })
    if (-not $dsc -and $needed) {
        $problems.Add("'engine' is DscV3 but the dsc command-line engine is not on PATH. Install it in an earlier step (see docs/requirements.md, 'DSC v3 engine'), or use a container image that includes it.")
    }
}
elseif ($engine -eq 'DscV2' -and -not $IsWindows) {
    $warnings.Add("'engine' is DscV2 on a non-Windows agent. DSC v2 needs the OMI library (libmi), which PowerShell on Linux and macOS does not include, and most DSC v2 resources only work on Windows. Use a Windows agent, or the DscV3 engine.")
}

# Azure DevOps connection.
if ($connect -eq 'AzureDevOps') {
    if (-not $settings['azure-devops-organization']) {
        $problems.Add("'connect' is AzureDevOps but 'azure-devops-organization' is empty.")
    }
    if ($mode -ne 'DryRun' -and $settings['azure-devops-authentication'] -eq 'PAT') {
        $tokenSet = -not [string]::IsNullOrEmpty($settings['azure-devops-token'])
        Add-Requirement 'Azure DevOps personal access token' $tokenSet $(if ($tokenSet) { 'set' } else { 'not set' })
        if (-not $tokenSet) {
            $problems.Add("'connect' is AzureDevOps with PAT authentication but 'azure-devops-token' is empty. Supply it from the secret store, or set 'azure-devops-authentication' to ManagedIdentity.")
        }
        elseif ($settings['azure-devops-token'] -notmatch '\A[A-Za-z0-9]{20,120}\z') {
            $problems.Add("'azure-devops-token' is not in the expected format (20 to 120 letters and digits). Check the secret is defined and passed to this step.")
        }
    }
}
elseif ($settings['azure-devops-organization'] -or $settings['azure-devops-token']) {
    $warnings.Add("Azure DevOps settings are set but 'connect' is None, so they are ignored. Set 'connect' to AzureDevOps to use them.")
}

# Installation.
$skipInstall = Test-Flag 'skip-module-install'
if ($settings['module-version'] -and $settings['module-version'] -notmatch '\A\d+\.\d+\.\d+(\.\d+)?(-[0-9A-Za-z]+)?\z') {
    $problems.Add("'module-version' is '$($settings['module-version'])'. Use an exact version such as 1.2.1 (or 1.3.0-preview1 with allow-prerelease), or leave it empty.")
}
if ($settings['module-version'] -match '-' -and -not (Test-Flag 'allow-prerelease')) {
    $problems.Add("'module-version' names a preview ($($settings['module-version'])) but 'allow-prerelease' is false.")
}
if ($settings['module-repository'] -notmatch '\A[A-Za-z0-9][A-Za-z0-9_.-]*\z') {
    $problems.Add("'module-repository' is not a valid repository name.")
}

$resourceModules = [System.Collections.Generic.List[object]]::new()
foreach ($entry in ($settings['resource-modules'] -split '[,\r\n]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
    if ($entry -match '\A(?<name>[A-Za-z0-9][A-Za-z0-9_.-]*)(@(?<version>\d+(\.\d+){1,3}(-[0-9A-Za-z]+)?))?\z') {
        $resourceModules.Add([pscustomobject]@{ Name = $Matches['name']; Version = [string]$Matches['version'] })
        if (-not $Matches['version']) { $warnings.Add("Resource module '$($Matches['name'])' has no version, so the newest is installed. Pin it as $($Matches['name'])@<version>.") }
    }
    else {
        $problems.Add("'resource-modules' entry '$entry' is not valid. Use Name or Name@Version, for example PSDscResources@2.12.0.0.")
    }
}
# Module from the source repository instead of a published release.
$fromSource = $settings['module-source'] -eq 'Repository'
if ($fromSource) {
    $sourceGit = Get-Command -Name git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    Add-Requirement 'git (to clone the module source repository)' ($null -ne $sourceGit) $(if ($sourceGit) { $sourceGit.Source } else { 'not found on PATH' })
    if (-not $sourceGit) { $problems.Add("'module-source' is Repository but git is not installed on the agent (not found on PATH).") }
    if (-not $settings['module-source-repository']) {
        $problems.Add("'module-source' is Repository but 'module-source-repository' is empty.")
    }
    elseif ($settings['module-source-repository'] -match '^[a-z][a-z0-9+.-]*://[^/@]*:[^/@]*@') {
        $problems.Add("'module-source-repository' contains a password or token. Remove it from the URL; use a credential helper or an SSH key on the agent for a private repository.")
    }
    if (-not $settings['module-source-ref']) {
        $problems.Add("'module-source' is Repository but 'module-source-ref' is empty. Name the tag, branch or commit to build; a full commit SHA is recommended.")
    }
    elseif ($settings['module-source-ref'] -notmatch '\A[A-Za-z0-9][A-Za-z0-9._/+-]*\z' -or $settings['module-source-ref'] -match '\.\.') {
        $problems.Add("'module-source-ref' is not a valid tag, branch or commit name.")
    }
    elseif ($settings['module-source-ref'] -notmatch '\A[0-9a-f]{40}\z') {
        $warnings.Add("'module-source-ref' is not a full commit SHA, so what is built can change between runs. Pin a 40-character commit SHA.")
    }
    if ($skipInstall) {
        $problems.Add("'module-source' is Repository and 'skip-module-install' is true. Building from source installs its build dependencies; set 'skip-module-install' to false, or use 'module-source: Gallery' with a module already on the agent.")
    }
    if ($settings['module-version']) {
        $warnings.Add("'module-version' is ignored because 'module-source' is Repository; the version is whatever 'module-source-ref' builds.")
    }
    $warnings.Add("'module-source' is Repository: the build script of $($settings['module-source-repository'] -replace '(?<=://)[^/@\s]+@', '***@') runs on this agent. Use only a repository you trust.")
}
elseif ($settings['module-source-ref']) {
    $warnings.Add("'module-source-ref' is set but 'module-source' is Gallery, so it is ignored. Set 'module-source' to Repository to build from source.")
}

if (-not $settings['module-version'] -and -not $skipInstall -and -not $fromSource) {
    $warnings.Add("'module-version' is empty, so the newest stable Dsc.PipelineRunner is used unless one is already installed. Pin an exact version.")
}

# Capability policy (preview). The policy is normally Policy.yml at the root of the configuration,
# beside Datum.yml, and the runner finds it there itself; policy-path names another file.
$policyPath = $null
$policyInConfiguration = $null
if ($settings['policy-path']) {
    $policyPath = [System.IO.Path]::GetFullPath($settings['policy-path'], (Get-Location).Path)
    $policyExists = Test-Path -LiteralPath $policyPath -PathType Leaf
    Add-Requirement 'Capability policy file (policy-path)' $policyExists $policyPath
    if (-not $policyExists) { $problems.Add("'policy-path' does not exist or is not a file: $policyPath.") }
}
if ($null -ne $configurationPath -and (Test-Path -LiteralPath $configurationPath -PathType Container)) {
    $policyInConfiguration = 'Policy.yml', 'Policy.yaml' | ForEach-Object { Join-Path $configurationPath $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($policyInConfiguration -and -not $policyPath) {
        Add-Requirement 'Capability policy (Policy.yml beside Datum.yml)' $true $policyInConfiguration
    }
    elseif (-not $policyInConfiguration -and -not $policyPath -and (Test-Flag 'require-policy')) {
        Add-Requirement 'Capability policy (required)' $false 'no Policy.yml beside Datum.yml, and no policy-path'
        $problems.Add("'require-policy' is true, but the configuration has no Policy.yml beside its Datum.yml and 'policy-path' is empty.")
    }
}
# Whether this run depends on the runner enforcing a policy. If it does, a module that cannot
# enforce one must stop the run rather than ignore the policy.
$policyExpected = [bool]$policyPath -or [bool]$policyInConfiguration -or (Test-Flag 'require-policy')

# Report directory.
$reportPath = [System.IO.Path]::GetFullPath($settings['report-path'], (Get-Location).Path)
try {
    $null = New-Item -ItemType Directory -Path $reportPath -Force -ErrorAction Stop
    Add-Requirement 'Report directory is writable' $true $reportPath
}
catch {
    Add-Requirement 'Report directory is writable' $false $reportPath
    $problems.Add("'report-path' could not be created: $reportPath ($($_.Exception.Message))")
}

if ($mode -eq 'Set') {
    $warnings.Add("'mode' is Set: this run changes the systems the configuration targets. The agent's identity needs the rights to make those changes.")
}

#endregion

# Writes the result where each platform and any later step can read it: result.json and
# outputs.env in the report directory, and the platform's own outputs. Used for a finished run and
# for settings that were not valid, so a caller always gets a status.
function Publish-StepResult {
    param([System.Collections.IDictionary] $Result)

    $resultObject = [pscustomobject]$Result
    $resultObject | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $reportPath 'result.json') -Encoding utf8

    $outputs = [ordered]@{
        'status'          = $result.Status
        'total-resources' = $result.TotalResources
        'pass-count'      = $result.PassCount
        'fail-count'      = $result.FailCount
        'skip-count'      = $result.SkipCount
        'report-path'     = $result.ReportPath
        'module-version'  = $result.ModuleVersion
    }

    # outputs.env: KEY=value, for platforms that load a dotenv file (GitLab reports:dotenv, Jenkins,
    # CircleCI) and for any script that wants the values.
    $envLines = foreach ($key in $outputs.Keys) { 'DSCPR_{0}={1}' -f ($key.ToUpperInvariant() -replace '-', '_'), (ConvertTo-SingleLine ([string]$outputs[$key])) }
    $envLines | Set-Content -LiteralPath (Join-Path $reportPath 'outputs.env') -Encoding utf8

    switch ($Platform) {
        'github' {
            if ($env:GITHUB_OUTPUT) {
                foreach ($key in $outputs.Keys) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value ('{0}={1}' -f $key, (ConvertTo-SingleLine ([string]$outputs[$key]))) }
            }
            if ($env:GITHUB_STEP_SUMMARY) {
                $lines = @(
                    "### Dsc.PipelineRunner: $($result.Status)"
                    ''
                    '| Mode | Engine | Resources | Passed | Failed | Skipped | Module |'
                    '| --- | --- | ---: | ---: | ---: | ---: | --- |'
                    ('| {0} | {1} | {2} | {3} | {4} | {5} | {6} |' -f $mode, $engine, $result.TotalResources, $result.PassCount, $result.FailCount, $result.SkipCount, $result.ModuleVersion)
                )
                Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $lines
            }
        }
        'azure-devops' {
            foreach ($key in $outputs.Keys) {
                $name = ($key -replace '-', '_')
                Write-Host ('##vso[task.setvariable variable={0};isOutput=true]{1}' -f $name, (ConvertTo-SingleLine ([string]$outputs[$key])))
            }
        }
    }

    Write-Host ''
    Write-Host ("Dsc.PipelineRunner {0}: {1} resource(s), {2} passed, {3} failed, {4} skipped. Reports: {5}" -f `
            $result.Status, $result.TotalResources, $result.PassCount, $result.FailCount, $result.SkipCount, $reportPath)
    return $resultObject
}

#region present requirements and settings ------------------------------------------------------

Write-StepGroup 'Dsc.PipelineRunner: requirements'
Write-Host ("Platform: {0}" -f $Platform)
Write-StepTable -Row $requirements -Column 'Requirement', 'Status', 'Detail'
Write-StepGroup -End

Write-StepGroup 'Dsc.PipelineRunner: settings'
$settingRows = foreach ($item in $definition.settings) {
    $value = $settings[$item.name]
    $shown = if ($item.secret) { if ([string]::IsNullOrEmpty($value)) { '(not set)' } else { '(set, hidden)' } }
    elseif ([string]::IsNullOrEmpty($value)) { '(empty)' }
    else { (($value -replace '\r?\n', ', ') -replace '(?<=://)[^/@\s]+@', '***@') }   # never show a credential embedded in a URL
    $origin = if ($value -eq [string]$item.default) { 'default' } else { 'set' }
    [pscustomobject]@{ Setting = $item.name; Value = $shown; Origin = $origin }
}
Write-StepTable -Row $settingRows -Column 'Setting', 'Value', 'Origin'
Write-Host 'Every setting is described in docs/settings.md.'
Write-StepGroup -End

foreach ($warning in $warnings) { Write-StepProblem -Level warning -Message $warning }

$result = [ordered]@{
    Status         = 'NotRun'
    Mode           = $mode
    Engine         = $engine
    TotalResources = 0
    PassCount      = 0
    FailCount      = 0
    SkipCount      = 0
    ReportPath     = $reportPath
    ModuleVersion  = ''
    Problems       = @($problems)
    Warnings       = @($warnings)
}

if ($problems.Count -gt 0) {
    Write-Host ''
    Write-Host ("{0} problem(s) must be fixed before Dsc.PipelineRunner can run:" -f $problems.Count)
    foreach ($problem in $problems) { Write-StepProblem -Message $problem }
    $result.Status = 'InvalidSettings'
    # Publish the status where the report directory could be made, so every platform's caller can
    # read 'InvalidSettings' instead of finding nothing.
    $invalidResult = [pscustomobject]$result
    if (Test-Path -LiteralPath $reportPath -PathType Container) {
        try { $invalidResult = Publish-StepResult -Result $result } catch { Write-StepProblem -Level warning -Message "The result could not be written to ${reportPath}: $($_.Exception.Message)" }
    }
    return (Exit-Step -Code 2 -Result $invalidResult)
}

if ($PreflightOnly) {
    Write-Host 'Preflight only: settings and requirements are valid. Nothing was installed or run.'
    $result.Status = 'PreflightPassed'
    return (Exit-Step -Code 0 -Result ([pscustomobject]$result))
}

#endregion

#region install --------------------------------------------------------------------------------

function Install-StepModule {
    param([string] $Name, [string] $Version, [string] $Repository, [switch] $Prerelease)

    $installed = @(Get-Module -ListAvailable -Name $Name)
    if ($Version) {
        $plain = ($Version -split '-')[0]
        if ($installed | Where-Object { [string]$_.Version -eq $plain }) {
            Write-Host "  $Name $Version is already installed."
            return
        }
    }
    elseif ($installed.Count -gt 0) {
        Write-Host ("  {0} {1} is already installed (no version requested)." -f $Name, ($installed | Sort-Object Version -Descending | Select-Object -First 1).Version)
        return
    }

    # Install-Module (PowerShellGet) is preferred where it exists: it is the documented way to
    # install Dsc.PipelineRunner, and it resolves the module's dependencies to their newest
    # allowed versions. Install-PSResource resolves a dependency that only has a maximum version
    # to an old release (it picked datum 0.0.21), which does not load.
    $usePsResourceGet = -not (Get-Command -Name Install-Module -ErrorAction SilentlyContinue)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if ($usePsResourceGet) {
                $arguments = @{ Name = $Name; Repository = $Repository; Scope = 'CurrentUser'; TrustRepository = $true; Prerelease = [bool]$Prerelease; ErrorAction = 'Stop' }
                if ($Version) { $arguments.Version = "[$Version]" }
                Install-PSResource @arguments
            }
            else {
                $arguments = @{ Name = $Name; Repository = $Repository; Scope = 'CurrentUser'; Force = $true; AllowClobber = $true; SkipPublisherCheck = $true; AllowPrerelease = [bool]$Prerelease; ErrorAction = 'Stop' }
                if ($Version) { $arguments.RequiredVersion = $Version }
                Install-Module @arguments
            }
            Write-Host ("  Installed {0} {1} from {2}." -f $Name, $(if ($Version) { $Version } else { '(newest)' }), $Repository)
            return
        }
        catch {
            if ($attempt -eq 3) { throw "Could not install module '$Name' $Version from repository '$Repository' after 3 attempts: $($_.Exception.Message)" }
            Write-Host "  Attempt $attempt to install $Name failed; retrying. ($($_.Exception.Message))"
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

# Clones the module's source repository at a ref, builds it with the repository's own build script
# and installs its run-time dependencies. Returns the path of the built module manifest.
function Install-StepModuleFromSource {
    param([string] $Repository, [string] $Ref)

    $pwsh = (Get-Process -Id $PID).Path
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ('dscpr-source-' + [guid]::NewGuid().ToString('N'))
    # Remembered so the clone can be removed when the step ends, however it ends.
    $script:sourceWorkDirectory = $work

    Write-Host "  Cloning the module source at '$Ref'."
    # Arguments are passed as an array (never through a shell), and '--' ends option parsing,
    # so neither the URL nor the ref can be read as a git option.
    & git clone --quiet --no-checkout -- $Repository $work 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "Could not clone the module source repository (git exit code $LASTEXITCODE). Check 'module-source-repository' and the agent's access to it." }
    # Resolve the ref to a commit first. A fresh clone has a local branch only for the default
    # branch; any other branch exists as origin/<name>, which a detached checkout does not look for.
    $commit = $null
    foreach ($candidate in "$Ref^{commit}", "origin/$Ref^{commit}") {
        # Not piped into Select-Object: stopping the pipeline early leaves $LASTEXITCODE unset.
        $resolved = @(& git -C $work rev-parse --verify --quiet --end-of-options $candidate 2>$null)
        if ($LASTEXITCODE -eq 0 -and $resolved.Count -gt 0) { $commit = ([string]$resolved[0]).Trim(); break }
    }
    if (-not $commit) { throw "Could not find '$Ref' in the module source repository. Check 'module-source-ref': it must be a tag, a branch or a commit of that repository." }

    & git -C $work checkout --quiet --detach $commit -- 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "Could not check out '$Ref' ($commit) in the module source repository." }

    $head = (& git -C $work rev-parse HEAD | Select-Object -First 1).Trim()
    if ($Ref -match '\A[0-9a-f]{40}\z' -and $head -ne $Ref) {
        throw "The module source checkout is at $head, not the requested commit $Ref."
    }
    Write-Host "  Building commit $head."

    # The build script is Build.ps1 or build.ps1 depending on the commit; file systems differ in case sensitivity.
    $buildScript = Get-ChildItem -LiteralPath $work -File | Where-Object { $_.Name -ieq 'build.ps1' } | Select-Object -First 1
    if (-not $buildScript) { throw "The module source repository has no build.ps1 at '$Ref'; it does not look like Dsc.PipelineRunner." }

    # Commits up to and including the 1.2 line have build tasks that look for 'Output' while the
    # build writes 'output'. That only works on a case-insensitive file system, so on Linux and
    # macOS give those commits an 'Output' that is the same directory.
    if (-not $IsWindows) {
        $null = New-Item -ItemType Directory -Path (Join-Path $work 'output') -Force
        if (-not (Test-Path -LiteralPath (Join-Path $work 'Output'))) {
            $null = New-Item -ItemType SymbolicLink -Path (Join-Path $work 'Output') -Target (Join-Path $work 'output')
        }
    }

    # A separate process: the build loads its own tool modules, which must not leak into the run.
    & $pwsh -NoLogo -NoProfile -NonInteractive -File $buildScript.FullName -ResolveDependency -Tasks build 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "Building the module from source failed (exit code $LASTEXITCODE). See the build output above." }

    # The built module is output/Dsc.PipelineRunner/<version>/ (or under output/builtModule/ when
    # the build is configured that way). output/RequiredModules holds build tools, not the result.
    $manifest = Get-ChildItem -Path (Join-Path $work 'output') -Recurse -Filter 'Dsc.PipelineRunner.psd1' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '[\\/]RequiredModules[\\/]' -and $_.Directory.Parent.Name -eq 'Dsc.PipelineRunner' } |
        Sort-Object -Property FullName | Select-Object -First 1
    if (-not $manifest) { throw 'The build finished but produced no Dsc.PipelineRunner module under its output directory.' }

    # Run-time dependencies. Newer commits carry a pinned installer; use it when it is there.
    $pinnedInstaller = Join-Path $work 'scripts/Install-PinnedModule.ps1'
    # A manifest with no RequiredModules must give an empty list, not a list holding $null.
    $required = @((Import-PowerShellDataFile -LiteralPath $manifest.FullName).RequiredModules |
            Where-Object { $null -ne $_ } | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.ModuleName } } | Where-Object { $_ })
    if ((Test-Path -LiteralPath $pinnedInstaller) -and $required.Count -gt 0) {
        Write-Host "  Installing the pinned run-time dependencies: $($required -join ', ')."
        & $pinnedInstaller -Name $required | ForEach-Object { Write-Host "    $_" }
    }
    else {
        foreach ($name in $required) { Install-StepModule -Name $name -Version '' -Repository $settings['module-repository'] }
    }

    Write-Host "  Built $($manifest.FullName)"
    return $manifest.FullName
}

$sourceManifest = $null
$script:sourceWorkDirectory = $null

try {
    Write-StepGroup 'Dsc.PipelineRunner: modules'
    if ($skipInstall) {
        Write-Host "  'skip-module-install' is true: nothing is installed."
    }
    else {
        if ($fromSource) {
            $sourceManifest = Install-StepModuleFromSource -Repository $settings['module-source-repository'] -Ref $settings['module-source-ref']
        }
        else {
            Install-StepModule -Name 'Dsc.PipelineRunner' -Version $settings['module-version'] -Repository $settings['module-repository'] -Prerelease:(Test-Flag 'allow-prerelease')
        }
        foreach ($module in $resourceModules) {
            Install-StepModule -Name $module.Name -Version $module.Version -Repository $settings['module-repository'] -Prerelease:($module.Version -match '-')
        }
    }

    $missing = @()
    if (-not $sourceManifest -and -not (Get-Module -ListAvailable -Name 'Dsc.PipelineRunner')) { $missing += 'Dsc.PipelineRunner' }
    foreach ($module in $resourceModules) { if (-not (Get-Module -ListAvailable -Name $module.Name)) { $missing += $module.Name } }
    if ($connect -eq 'AzureDevOps' -and $mode -ne 'DryRun' -and -not (Get-Module -ListAvailable -Name 'AzureDevOpsDsc.Common')) {
        $missing += "AzureDevOpsDsc.Common (needed for connect: AzureDevOps; add AzureDevOpsDscNative to 'resource-modules')"
    }
    if ($missing.Count -gt 0) {
        throw "Required module(s) are not installed on the agent: $($missing -join '; '). Install them in the agent image, or set 'skip-module-install' to false."
    }

    # Dsc.PipelineRunner and the DSC modules are written for PowerShell's default error handling
    # (non-terminating errors are reported and the run continues; the runner records them per
    # resource). Some CI shells set $ErrorActionPreference = 'Stop' globally (GitHub Actions does
    # for pwsh steps), which would turn the first such error into an abort. Run the module under
    # the default, and put the caller's preference back afterwards.
    # Both scopes matter: module functions read the global preference, and a module's
    # ScriptsToProcess runs in this script's scope.
    $callerErrorActionPreference = $global:ErrorActionPreference
    $global:ErrorActionPreference = 'Continue'
    $ErrorActionPreference = 'Continue'

    # If a Dsc.PipelineRunner is already loaded in this session it may not be the one asked for.
    # Unload it so the import below decides which version runs.
    Remove-Module -Name 'Dsc.PipelineRunner' -Force -ErrorAction Ignore

    $importArguments = @{ Name = 'Dsc.PipelineRunner'; PassThru = $true }
    if ($sourceManifest) { $importArguments.Name = $sourceManifest }
    elseif ($settings['module-version']) { $importArguments.RequiredVersion = ($settings['module-version'] -split '-')[0] }
    $runnerModule = Import-Module @importArguments
    if (-not $runnerModule) { throw 'The Dsc.PipelineRunner module could not be imported. See the errors above.' }
    $runnerModule = @($runnerModule)[0]
    $result.ModuleVersion = [string]$runnerModule.Version
    if ($runnerModule.PrivateData -and $runnerModule.PrivateData.PSData -and $runnerModule.PrivateData.PSData['Prerelease']) {
        $result.ModuleVersion = '{0}-{1}' -f $runnerModule.Version, $runnerModule.PrivateData.PSData['Prerelease']
    }
    Write-Host "  Using Dsc.PipelineRunner $($result.ModuleVersion)."
    Write-StepGroup -End

    $runnerCommand = Get-Command -Name Invoke-DscRunner -Module Dsc.PipelineRunner
    if ($policyExpected -and -not $runnerCommand.Parameters.ContainsKey('PolicyPath')) {
        $reason = if ($policyPath) { "'policy-path' is set" } elseif ($policyInConfiguration) { "the configuration has a Policy.yml" } else { "'require-policy' is true" }
        throw "A capability policy is expected ($reason), but Dsc.PipelineRunner $($result.ModuleVersion) cannot enforce one and would ignore it. Set 'module-version' to a release that supports capability policies, or build a newer commit with 'module-source: Repository'."
    }
    if ($mode -eq 'DryRun' -and 'DryRun' -notin $runnerCommand.Parameters['Mode'].Attributes.Where({ $_ -is [ValidateSet] }).ValidValues) {
        throw "'mode' is DryRun, but Dsc.PipelineRunner $($result.ModuleVersion) does not support it. Set 'module-version' to a release that does, or build a newer commit with 'module-source: Repository'."
    }

    #endregion

    #region run --------------------------------------------------------------------------------

    $runArguments = @{ Mode = $mode; Engine = $engine; ReportPath = $reportPath }
    if ($settings['engine-version']) { $runArguments.EngineVersion = $settings['engine-version'] }
    if (Test-Flag 'keep-temporary-directory') { $runArguments.KeepTemporaryDirectory = $true }
    if (Test-Flag 'verbose') { $runArguments.Verbose = $true }
    if ($policyPath) { $runArguments.PolicyPath = $policyPath }
    if (Test-Flag 'require-policy') { $runArguments.RequirePolicy = $true }

    if ($hasPath) {
        $runArguments.ConfigurationSourcePath = $configurationPath
    }
    else {
        $sourceContext = @{ Url = $settings['configuration-repository-url'] }
        if ($settings['source-token']) { $sourceContext.Token = ConvertTo-SecureString -String $settings['source-token'] -AsPlainText -Force }
        $runArguments.Source = 'Git'
        $runArguments.SourceContext = $sourceContext
        if ($settings['configuration-revision']) { $runArguments.ConfigurationRevision = $settings['configuration-revision'] }
    }

    if ($connect -eq 'AzureDevOps') {
        $connectContext = @{ OrganizationName = $settings['azure-devops-organization']; AuthenticationType = $settings['azure-devops-authentication'] }
        if ($settings['azure-devops-authentication'] -eq 'PAT') { $connectContext.PATToken = $settings['azure-devops-token'] }
        $runArguments.Connect = 'AzureDevOps'
        $runArguments.ConnectContext = $connectContext
    }

    Write-StepGroup "Dsc.PipelineRunner: run ($mode, $engine)"
    $summary = Invoke-DscRunner @runArguments -InformationAction Continue
    Write-StepGroup -End

    # The runner may emit more than the summary object; the summary is the last object with a Status.
    $summary = @($summary | Where-Object { $null -ne $_ -and $_.PSObject.Properties['Status'] -and $_.PSObject.Properties['PassCount'] }) | Select-Object -Last 1
    if ($null -eq $summary) { throw 'Invoke-DscRunner returned no run summary.' }

    $result.Status = [string]$summary.Status
    $result.TotalResources = [int]$summary.TotalResources
    $result.PassCount = [int]$summary.PassCount
    $result.FailCount = [int]$summary.FailCount
    $result.SkipCount = [int]$summary.SkipCount
}
catch {
    Write-StepGroup -End
    $result.Status = 'Aborted'
    $result.Problems = @($_.Exception.Message)
    Write-StepProblem -Message "Dsc.PipelineRunner did not complete: $($_.Exception.Message)"
}
finally {
    $ErrorActionPreference = 'Stop'
    if (Get-Variable -Name callerErrorActionPreference -ErrorAction Ignore) { $global:ErrorActionPreference = $callerErrorActionPreference }
}

#endregion

#region publish result -------------------------------------------------------------------------

$resultObject = Publish-StepResult -Result $result

$failed = $result.Status -in 'Failed', 'Aborted'
$exitCode = 0
if ($result.Status -eq 'Aborted' -and $result.TotalResources -eq 0) {
    # The runner could not run at all (install, import or an exception): always a failure.
    $exitCode = 1
}
elseif ($failed -and (Test-Flag 'fail-on-error')) {
    Write-StepProblem -Message "The run status is $($result.Status) and 'fail-on-error' is true, so this step fails. See the reports in $reportPath."
    $exitCode = 1
}
elseif ($failed) {
    Write-StepProblem -Level warning -Message "The run status is $($result.Status). 'fail-on-error' is false, so this step does not fail."
}

# Remove the source clone and build (module-source: Repository), unless asked to keep temporary
# files. The module was imported from there, so unload it first. git marks its object files
# read-only, which stops a plain delete on Windows.
if ($script:sourceWorkDirectory -and (Test-Path -LiteralPath $script:sourceWorkDirectory)) {
    if (Test-Flag 'keep-temporary-directory') {
        Write-Host "The module source and build were kept at $script:sourceWorkDirectory ('keep-temporary-directory' is true)."
    }
    else {
        try {
            Remove-Module -Name 'Dsc.PipelineRunner' -Force -ErrorAction Ignore
            Get-ChildItem -LiteralPath $script:sourceWorkDirectory -Recurse -Force -File -ErrorAction SilentlyContinue |
                Where-Object { $_.IsReadOnly } | ForEach-Object { $_.IsReadOnly = $false }
            Remove-Item -LiteralPath $script:sourceWorkDirectory -Recurse -Force -ErrorAction Stop
        }
        catch {
            Write-StepProblem -Level warning -Message "The module source at $script:sourceWorkDirectory could not be removed: $($_.Exception.Message)"
        }
    }
}

return (Exit-Step -Code $exitCode -Result $resultObject)

#endregion
