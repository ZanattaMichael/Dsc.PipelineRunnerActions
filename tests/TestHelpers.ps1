#requires -Version 7.0
# Shared helpers for the step tests. Dot-source in BeforeAll:  . (Join-Path $PSScriptRoot 'TestHelpers.ps1')

$script:Root = Split-Path -Parent $PSScriptRoot
$script:Step = Join-Path $script:Root 'core/Invoke-DscPipelineRunnerStep.ps1'
$script:Config = Join-Path $PSScriptRoot 'fixtures/config'
$script:FixtureModules = Join-Path $PSScriptRoot 'fixtures/modules'
$script:OldFixtureModules = Join-Path $PSScriptRoot 'fixtures/modules-old'

# Runs the step in this session (so Pester mocks apply to what it calls) and captures:
#   $Text    everything it wrote to the host, as one string
#   $Result  the result object it returned
#   $Call    the arguments the stand-in Invoke-DscRunner recorded (or $null if it was never called)
function Invoke-Step {
    param([hashtable] $Setting = @{}, [string] $Platform = 'generic', [switch] $PreflightOnly, [switch] $NoDefaults)
    $base = if ($NoDefaults) { @{} } else { @{ 'skip-module-install' = 'true'; 'report-path' = $script:Reports } }
    foreach ($key in $Setting.Keys) { $base[$key] = $Setting[$key] }
    $log = & $script:Step -Setting $base -Platform $Platform -NoExit -PreflightOnly:$PreflightOnly 6>&1
    # 6>&1 turns Write-Host output into InformationRecord objects; everything else is output.
    $script:Text = ($log | Where-Object { $_ -is [System.Management.Automation.InformationRecord] } | ForEach-Object { [string]$_.MessageData }) -join "`n"
    $script:Result = $log | Where-Object { $_ -isnot [System.Management.Automation.InformationRecord] -and $_.PSObject.Properties['Status'] } | Select-Object -Last 1
    $script:Call = if (Test-Path -LiteralPath $env:DSCPR_TEST_CALL_FILE) { Get-Content -LiteralPath $env:DSCPR_TEST_CALL_FILE -Raw | ConvertFrom-Json } else { $null }
}

# State every test starts from: a fresh report directory and call file, no DSCPR_* settings, no
# CI-platform variables (these tests themselves run inside a CI system), the stand-in modules first
# on PSModulePath and no Dsc.PipelineRunner loaded.
function Reset-StepTestState {
    $script:Reports = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
    $env:DSCPR_TEST_CALL_FILE = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.json')
    Get-ChildItem Env:DSCPR_* | Where-Object Name -NE 'DSCPR_TEST_CALL_FILE' | Remove-Item
    foreach ($name in 'GITHUB_ACTIONS', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'TF_BUILD', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL') {
        Remove-Item -Path "Env:$name" -ErrorAction Ignore
    }
    $env:PSModulePath = $script:FixtureModules + [System.IO.Path]::PathSeparator + $script:BasePSModulePath
    Remove-Module -Name 'Dsc.PipelineRunner' -Force -ErrorAction Ignore
}

# Remembers the environment the test run started with; Restore-StepTestEnvironment puts it back.
function Save-StepTestEnvironment {
    $script:BasePSModulePath = $env:PSModulePath
    $script:SavedEnvironment = @{}
    foreach ($name in 'GITHUB_ACTIONS', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'TF_BUILD', 'GITLAB_CI', 'CIRCLECI', 'JENKINS_URL') {
        $script:SavedEnvironment[$name] = [System.Environment]::GetEnvironmentVariable($name)
    }
}

function Restore-StepTestEnvironment {
    $env:PSModulePath = $script:BasePSModulePath
    foreach ($name in $script:SavedEnvironment.Keys) { [System.Environment]::SetEnvironmentVariable($name, $script:SavedEnvironment[$name]) }
    Get-ChildItem Env:DSCPR_* | Remove-Item
    Remove-Module -Name 'Dsc.PipelineRunner' -Force -ErrorAction Ignore
}

# Builds a small local git repository that looks like the module's source repository to the step:
# a build.ps1 that "builds" a stand-in Dsc.PipelineRunner 7.7.7 into output/. Branches hold the
# variations the tests need. Returns the repository path; nothing here touches the network.
function New-SourceRepository {
    param([string] $Path)

    $null = New-Item -ItemType Directory -Path (Join-Path $Path 'module') -Force
    function git-here { & git -C $Path @args 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed in the test repository." } }
    function commit-all { param([string] $Message) git-here add -A; git-here commit -q -m $Message }

    & git init -q $Path 2>&1 | Out-Null
    git-here checkout -q -b main
    git-here config user.name 'Step Tests'
    git-here config user.email 'step-tests@example.test'
    git-here config commit.gpgsign false
    git-here config core.autocrlf false

    Copy-Item -LiteralPath (Join-Path $script:FixtureModules 'Dsc.PipelineRunner/Dsc.PipelineRunner.psm1') -Destination (Join-Path $Path 'module')
    $manifest = "@{ RootModule = 'Dsc.PipelineRunner.psm1'; ModuleVersion = '7.7.7'; GUID = 'b0a7c1b4-2c64-4f0b-9d5e-6d5b0b0f7a11'; FunctionsToExport = 'Invoke-DscRunner'__REQUIRED__ }"
    Set-Content -LiteralPath (Join-Path $Path 'module/Dsc.PipelineRunner.psd1') -Value ($manifest -replace '__REQUIRED__', '')

    $build = @'
param([switch] $ResolveDependency, [string[]] $Tasks)
$out = Join-Path $PSScriptRoot '__OUTPUT__/Dsc.PipelineRunner/7.7.7'
$null = New-Item -ItemType Directory -Path $out -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'module/*') -Destination $out -Recurse
"fixture build: ResolveDependency=$ResolveDependency Tasks=$($Tasks -join ',')"
'@
    Set-Content -LiteralPath (Join-Path $Path 'build.ps1') -Value ($build -replace '__OUTPUT__', 'output')
    commit-all 'A source repository that builds'
    git-here tag v7.7.7

    # Build.ps1 (capital B) that writes to Output (capital O): the shape of the real module's older commits.
    git-here checkout -q -b capital main
    git-here rm -q build.ps1
    Set-Content -LiteralPath (Join-Path $Path 'Build.ps1') -Value ($build -replace '__OUTPUT__', 'Output')
    commit-all 'Build.ps1 writing to Output'

    git-here checkout -q -b no-build main
    git-here rm -q build.ps1
    commit-all 'No build script'

    git-here checkout -q -b build-fails main
    Set-Content -LiteralPath (Join-Path $Path 'build.ps1') -Value "'the fixture build is failing'; exit 3"
    commit-all 'A build that fails'

    git-here checkout -q -b build-empty main
    Set-Content -LiteralPath (Join-Path $Path 'build.ps1') -Value "'the fixture build produced nothing'"
    commit-all 'A build that produces nothing'

    # A run-time dependency, and no pinned installer.
    git-here checkout -q -b deps main
    Set-Content -LiteralPath (Join-Path $Path 'module/Dsc.PipelineRunner.psd1') -Value ($manifest -replace '__REQUIRED__', "; RequiredModules = @(@{ ModuleName = 'DscprTestDependency'; ModuleVersion = '1.0.0' })")
    commit-all 'A run-time dependency'

    # The same, with the repository's own pinned installer.
    git-here checkout -q -b pinned deps
    $null = New-Item -ItemType Directory -Path (Join-Path $Path 'scripts') -Force
    Set-Content -LiteralPath (Join-Path $Path 'scripts/Install-PinnedModule.ps1') -Value 'param([string[]] $Name) ($Name -join ",") | Set-Content -LiteralPath $env:DSCPR_TEST_MARKER; "pinned installer ran"'
    commit-all 'A pinned installer'

    git-here checkout -q main
    return $Path
}
