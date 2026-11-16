#requires -Version 7.0
# Tests for the shared step script (core/Invoke-DscPipelineRunnerStep.ps1). The real
# Dsc.PipelineRunner is replaced by tests/fixtures/modules/Dsc.PipelineRunner, which records the
# arguments it received, so these run anywhere without the PowerShell Gallery.

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot
    $script:Step = Join-Path $script:Root 'core/Invoke-DscPipelineRunnerStep.ps1'
    $script:Config = Join-Path $PSScriptRoot 'fixtures/config'
    $script:OriginalModulePath = $env:PSModulePath
    $env:PSModulePath = (Join-Path $PSScriptRoot 'fixtures/modules') + [System.IO.Path]::PathSeparator + $env:PSModulePath

    function Invoke-Step {
        param([hashtable] $Setting = @{}, [string] $Platform = 'generic', [switch] $PreflightOnly)
        $base = @{ 'skip-module-install' = 'true'; 'report-path' = $script:Reports }
        foreach ($key in $Setting.Keys) { $base[$key] = $Setting[$key] }
        $script:Log = & $script:Step -Setting $base -Platform $Platform -NoExit -PreflightOnly:$PreflightOnly 6>&1
        $script:Result = $script:Log | Where-Object { $_ -is [pscustomobject] -and $_.PSObject.Properties['Status'] } | Select-Object -Last 1
        $script:Text = ($script:Log | Where-Object { $_ -isnot [pscustomobject] } | Out-String)
        $script:Call = if (Test-Path $env:DSCPR_TEST_CALL_FILE) { Get-Content $env:DSCPR_TEST_CALL_FILE -Raw | ConvertFrom-Json } else { $null }
    }
}

AfterAll {
    $env:PSModulePath = $script:OriginalModulePath
}

Describe 'Invoke-DscPipelineRunnerStep' {

    BeforeEach {
        $script:Reports = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $env:DSCPR_TEST_CALL_FILE = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.json')
        $env:DSCPR_TEST_STATUS = $null
        $env:DSCPR_TEST_THROW = $null
        Get-ChildItem Env:DSCPR_* | Where-Object Name -NotLike 'DSCPR_TEST_*' | Remove-Item
        $env:GITHUB_OUTPUT = $null
        $env:GITHUB_STEP_SUMMARY = $null
    }

    Context 'Settings are validated before anything runs' {

        It 'Fails with InvalidSettings when no configuration source is given' {
            Invoke-Step
            $Result.Status | Should -Be 'InvalidSettings'
            $Text | Should -Match 'No configuration source'
            $Call | Should -BeNullOrEmpty
        }

        It 'Reports every problem in one pass, not just the first' {
            Invoke-Step -Setting @{ mode = 'Apply'; connect = 'AzureDevOps'; 'module-version' = 'latest'; 'resource-modules' = 'Bad Name' }
            $Result.Status | Should -Be 'InvalidSettings'
            $Result.Problems.Count | Should -BeGreaterOrEqual 5
            $Text | Should -Match "'mode' is 'Apply'"
            $Text | Should -Match 'azure-devops-organization'
            $Text | Should -Match "'module-version' is 'latest'"
            $Text | Should -Match "'resource-modules' entry 'Bad Name'"
        }

        It 'Rejects both a path and a repository URL' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'configuration-repository-url' = 'https://example.test/c.git' }
            $Text | Should -Match 'Both'
        }

        It 'Rejects a configuration path that does not exist' {
            Invoke-Step -Setting @{ 'configuration-path' = 'no-such-directory' }
            $Text | Should -Match 'does not exist'
        }

        It 'Rejects a repository URL that embeds a credential' {
            Invoke-Step -Setting @{ 'configuration-repository-url' = 'https://user:hunter2@example.test/c.git' }
            $Text | Should -Match 'contains a password or token'
            $Text | Should -Not -Match 'hunter2'
        }

        It 'Requires a token for an Azure DevOps PAT connection, but not for a dry run' {
            $azure = @{ 'configuration-path' = $Config; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso' }
            Invoke-Step -Setting $azure
            $Text | Should -Match "'azure-devops-token' is empty"

            Invoke-Step -Setting ($azure + @{ mode = 'DryRun' }) -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Requires the dsc engine for DscV3, but not for a dry run' {
            if (Get-Command dsc -CommandType Application -ErrorAction SilentlyContinue) { Set-ItResult -Skipped -Because 'dsc is installed here'; return }
            Invoke-Step -Setting @{ 'configuration-path' = $Config; engine = 'DscV3' }
            $Text | Should -Match 'dsc command-line engine is not on PATH'

            Invoke-Step -Setting @{ 'configuration-path' = $Config; engine = 'DscV3'; mode = 'DryRun' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Accepts fixed values in any letter case' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; mode = 'dryrun'; 'fail-on-error' = 'TRUE' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
            $Result.Mode | Should -Be 'DryRun'
        }
    }

    Context 'Requirements and settings are shown to the user' {

        It 'Prints every setting by name' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -PreflightOnly
            $names = (Get-Content (Join-Path $Root 'core/settings.json') -Raw | ConvertFrom-Json).settings.name
            foreach ($name in $names) { $Text | Should -Match ([regex]::Escape($name)) }
            $Text | Should -Match 'PowerShell 7.0 or later'
        }

        It 'Never prints a secret, only whether it is set' {
            Invoke-Step -Setting @{ 'configuration-repository-url' = 'https://example.test/c.git'; 'source-token' = 'super-secret-value-123' } -PreflightOnly
            $Text | Should -Not -Match 'super-secret-value-123'
            $Text | Should -Match '\(set, hidden\)'
        }

        It 'Warns when versions are not pinned' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'resource-modules' = 'PSDscResources'; 'skip-module-install' = 'false' } -PreflightOnly
            $Text | Should -Match "'module-version' is empty"
            $Text | Should -Match "Resource module 'PSDscResources' has no version"
        }
    }

    Context 'The runner is called with the right arguments' {

        It 'Passes a local configuration path, the mode, the engine and the report path' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; mode = 'Set' }
            $Result.Status | Should -Be 'Completed'
            $Call.ConfigurationSourcePath | Should -Be (Resolve-Path $Config).Path
            $Call.Mode | Should -Be 'Set'
            $Call.Engine | Should -Be 'DscV2'
            $Call.ReportPath | Should -Be $Reports
            $Call.PSObject.Properties.Name | Should -Not -Contain 'Source'
        }

        It 'Uses the Git source for a repository URL and passes the token as a SecureString' {
            if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { Set-ItResult -Skipped -Because 'git is not installed here'; return }
            Invoke-Step -Setting @{ 'configuration-repository-url' = 'https://example.test/c.git'; 'configuration-revision' = 'abc123'; 'source-token' = 'super-secret-value-123' }
            $Call.Source | Should -Be 'Git'
            $Call.SourceContext.Url | Should -Be 'https://example.test/c.git'
            $Call.SourceContext.TokenIsSecureString | Should -BeTrue
            $Call.ConfigurationRevision | Should -Be 'abc123'
        }

        It 'Passes the Azure DevOps connection' {
            New-Item -ItemType Directory -Path (Join-Path $TestDrive 'm/AzureDevOpsDsc.Common') -Force | Out-Null
            New-ModuleManifest -Path (Join-Path $TestDrive 'm/AzureDevOpsDsc.Common/AzureDevOpsDsc.Common.psd1') -ModuleVersion '1.0.0'
            $before = $env:PSModulePath
            $env:PSModulePath = (Join-Path $TestDrive 'm') + [System.IO.Path]::PathSeparator + $env:PSModulePath
            try {
                Invoke-Step -Setting @{ 'configuration-path' = $Config; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso'; 'azure-devops-token' = ('a' * 52) }
            }
            finally { $env:PSModulePath = $before }
            $Call.Connect | Should -Be 'AzureDevOps'
            $Call.ConnectContext.OrganizationName | Should -Be 'Contoso'
            $Call.ConnectContext.AuthenticationType | Should -Be 'PAT'
        }

        It 'Says which module is missing when the Azure DevOps module is not installed' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso'; 'azure-devops-token' = ('a' * 52) }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'AzureDevOpsDsc.Common'
        }

        It 'Reads settings from DSCPR_* environment variables' {
            $env:DSCPR_CONFIGURATION_PATH = $Config
            $env:DSCPR_MODE = 'DryRun'
            Invoke-Step
            $Call.Mode | Should -Be 'DryRun'
        }
    }

    Context 'Results, outputs and the exit decision' {

        It 'Writes result.json and outputs.env' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config }
            (Get-Content (Join-Path $Reports 'result.json') -Raw | ConvertFrom-Json).PassCount | Should -Be 3
            $envFile = Get-Content (Join-Path $Reports 'outputs.env')
            $envFile | Should -Contain 'DSCPR_STATUS=Completed'
            $envFile | Should -Contain 'DSCPR_MODULE_VERSION=9.9.9'
        }

        It 'Writes GitHub outputs and a job summary' {
            $env:GITHUB_OUTPUT = Join-Path $TestDrive 'gh-output'
            $env:GITHUB_STEP_SUMMARY = Join-Path $TestDrive 'gh-summary'
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform github
            Get-Content $env:GITHUB_OUTPUT | Should -Contain 'status=Completed'
            Get-Content $env:GITHUB_OUTPUT | Should -Contain 'pass-count=3'
            Get-Content $env:GITHUB_STEP_SUMMARY -Raw | Should -Match 'Dsc.PipelineRunner: Completed'
        }

        It 'Writes Azure DevOps output variables' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform azure-devops
            $Text | Should -Match '##vso\[task.setvariable variable=status;isOutput=true\]Completed'
            $Text | Should -Match '##vso\[task.setvariable variable=fail_count;isOutput=true\]0'
        }

        It 'Fails the step when the run failed and fail-on-error is true' {
            $env:DSCPR_TEST_STATUS = 'Failed'
            $global:LASTEXITCODE = 0
            pwsh -NoProfile -Command "`$env:PSModulePath = '$($env:PSModulePath)'; & '$Step' -Setting @{ 'configuration-path' = '$Config'; 'skip-module-install' = 'true'; 'report-path' = '$Reports' } -Platform generic" | Out-Null
            $LASTEXITCODE | Should -Be 1
        }

        It 'Does not fail the step when fail-on-error is false' {
            $env:DSCPR_TEST_STATUS = 'Failed'
            pwsh -NoProfile -Command "`$env:PSModulePath = '$($env:PSModulePath)'; & '$Step' -Setting @{ 'configuration-path' = '$Config'; 'skip-module-install' = 'true'; 'report-path' = '$Reports'; 'fail-on-error' = 'false' } -Platform generic" | Out-Null
            $LASTEXITCODE | Should -Be 0
            (Get-Content (Join-Path $Reports 'outputs.env')) | Should -Contain 'DSCPR_STATUS=Failed'
        }

        It 'Always fails when the runner could not run, and exits 2 for invalid settings' {
            $env:DSCPR_TEST_THROW = 'compile blew up'
            pwsh -NoProfile -Command "`$env:PSModulePath = '$($env:PSModulePath)'; & '$Step' -Setting @{ 'configuration-path' = '$Config'; 'skip-module-install' = 'true'; 'report-path' = '$Reports'; 'fail-on-error' = 'false' } -Platform generic" | Out-Null
            $LASTEXITCODE | Should -Be 1

            pwsh -NoProfile -Command "& '$Step' -Setting @{ 'report-path' = '$Reports' } -Platform generic" | Out-Null
            $LASTEXITCODE | Should -Be 2
        }

        It 'Cannot be made to emit a logging command through a message' {
            $env:DSCPR_TEST_THROW = "bad`n##vso[task.setvariable variable=x]1 ::set-output name=x::1"
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform azure-devops
            ($Text -split "`n" | Where-Object { $_ -match '^\s*##vso\[task\.setvariable variable=x' }) | Should -BeNullOrEmpty
        }
    }
}
