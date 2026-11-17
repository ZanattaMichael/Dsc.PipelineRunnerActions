#requires -Version 7.0
# How the step behaves around the run: which platform it writes for, what it passes to the runner,
# what it validates and warns about, and what it leaves behind.

BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    Save-StepTestEnvironment
}

AfterAll { Restore-StepTestEnvironment }

Describe 'Step behaviour' {

    BeforeEach { Reset-StepTestState }

    Context 'Which platform it writes for' {

        It 'Detects <Platform> from <Variable>' -ForEach @(
            @{ Platform = 'GitHub Actions'; Variable = 'GITHUB_ACTIONS'; Value = 'true'; Expect = '::group::Dsc\.PipelineRunner: requirements' }
            @{ Platform = 'Azure DevOps'; Variable = 'TF_BUILD'; Value = 'True'; Expect = '##\[group\]Dsc\.PipelineRunner: requirements' }
            @{ Platform = 'GitLab'; Variable = 'GITLAB_CI'; Value = 'true'; Expect = 'Platform: gitlab' }
            @{ Platform = 'CircleCI'; Variable = 'CIRCLECI'; Value = 'true'; Expect = 'Platform: circleci' }
            @{ Platform = 'Jenkins'; Variable = 'JENKINS_URL'; Value = 'https://jenkins.example.test/'; Expect = 'Platform: jenkins' }
        ) {
            [System.Environment]::SetEnvironmentVariable($Variable, $Value)
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform '' -PreflightOnly
            $Text | Should -Match $Expect
        }

        It 'Falls back to generic output when no platform is recognised' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform '' -PreflightOnly
            $Text | Should -Match 'Platform: generic'
            $Text | Should -Match '== Dsc\.PipelineRunner: requirements'
        }

        It 'Lets DSCPR_PLATFORM override what it detects' {
            $env:GITHUB_ACTIONS = 'true'
            $env:DSCPR_PLATFORM = 'generic'
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform '' -PreflightOnly
            $Text | Should -Match 'Platform: generic'
            $Text | Should -Not -Match '::group::'
        }

        It 'Writes problems and warnings the way <Platform> shows them' -ForEach @(
            @{ Platform = 'github'; Problem = '::error::No configuration source'; Warning = '::warning::' }
            @{ Platform = 'azure-devops'; Problem = '##vso\[task\.logissue type=error\]No configuration source'; Warning = '##vso\[task\.logissue type=warning\]' }
            @{ Platform = 'generic'; Problem = 'ERROR: No configuration source'; Warning = 'WARNING: ' }
        ) {
            Invoke-Step -Setting @{ mode = 'Set' } -Platform $Platform
            $Text | Should -Match $Problem
            $Text | Should -Match $Warning
        }

        It 'Marks the Azure DevOps task failed when the settings are not valid' {
            Invoke-Step -Platform 'azure-devops'
            $Text | Should -Match '##vso\[task\.complete result=Failed;\]'
        }

        It 'Does not mark the Azure DevOps task failed on success' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config } -Platform 'azure-devops'
            $Text | Should -Not -Match 'task\.complete'
        }
    }

    Context 'What reaches the runner' {

        It 'Passes engine-version, keep-temporary-directory and verbose' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; engine = 'DscV2'; 'engine-version' = '2.0.7'; 'keep-temporary-directory' = 'true'; verbose = 'true' }
            $Call.EngineVersion | Should -Be '2.0.7'
            $Call.KeepTemporaryDirectory | Should -BeTrue
            $Call.Verbose | Should -BeTrue
        }

        It 'Does not pass optional arguments that were not set' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config }
            foreach ($name in 'EngineVersion', 'KeepTemporaryDirectory', 'Verbose', 'Connect', 'ConnectContext', 'Source', 'SourceContext', 'ConfigurationRevision', 'FailOnError') {
                $Call.PSObject.Properties.Name | Should -Not -Contain $name
            }
        }

        It 'Resolves a relative configuration path and report path against the working directory' {
            $work = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
            Copy-Item -LiteralPath $Config -Destination (Join-Path $work 'my-config') -Recurse -Force
            Push-Location $work
            try { Invoke-Step -Setting @{ 'configuration-path' = 'my-config'; 'report-path' = 'out/reports' } }
            finally { Pop-Location }
            $Call.ConfigurationSourcePath | Should -Be (Join-Path $work 'my-config')
            $Result.ReportPath | Should -Be (Join-Path $work 'out/reports')
            Test-Path -LiteralPath (Join-Path $work 'out/reports/result.json') | Should -BeTrue
        }

        It 'Passes a managed identity connection without a token' {
            # DryRun, so the Azure DevOps module does not have to be installed for this test.
            Invoke-Step -Setting @{ 'configuration-path' = $Config; mode = 'DryRun'; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso'; 'azure-devops-authentication' = 'ManagedIdentity' }
            $Call.Connect | Should -Be 'AzureDevOps'
            $Call.ConnectContext.AuthenticationType | Should -Be 'ManagedIdentity'
            $Call.ConnectContext.PSObject.Properties.Name | Should -Not -Contain 'PATToken'
        }

        It 'Does not need a token for managed identity outside a dry run either' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso'; 'azure-devops-authentication' = 'ManagedIdentity' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Runs the module under default error handling and gives the caller its preference back' {
            $before = $global:ErrorActionPreference
            $global:ErrorActionPreference = 'Stop'
            try {
                Invoke-Step -Setting @{ 'configuration-path' = $Config }
                $Call.GlobalErrorActionPreference | Should -Be 'Continue'
                $global:ErrorActionPreference | Should -Be 'Stop'
            }
            finally { $global:ErrorActionPreference = $before }
        }

        It 'Gives the caller its error preference back when the runner throws' {
            $before = $global:ErrorActionPreference
            $global:ErrorActionPreference = 'Stop'
            $env:DSCPR_TEST_THROW = 'the runner blew up'
            try {
                Invoke-Step -Setting @{ 'configuration-path' = $Config }
                $Result.Status | Should -Be 'Aborted'
                $global:ErrorActionPreference | Should -Be 'Stop'
            }
            finally { $global:ErrorActionPreference = $before }
        }
    }

    Context 'Validation of individual settings' {

        It 'Accepts module-version <Value>' -ForEach @(
            @{ Value = '1.2.3' }, @{ Value = '1.2.3.4' }, @{ Value = '10.20.30' }
        ) {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = $Value } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Rejects module-version <Value>' -ForEach @(
            @{ Value = '1.2' }, @{ Value = 'v1.2.3' }, @{ Value = 'latest' }, @{ Value = '1.2.3;rm' }, @{ Value = '[1.0,2.0)' }
        ) {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = $Value } -PreflightOnly
            $Result.Status | Should -Be 'InvalidSettings'
            $Text | Should -Match "'module-version' is"
        }

        It 'Needs allow-prerelease for a preview version' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = '1.3.0-preview1' } -PreflightOnly
            $Text | Should -Match "names a preview \(1\.3\.0-preview1\) but 'allow-prerelease' is false"

            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = '1.3.0-preview1'; 'allow-prerelease' = 'true' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Accepts resource-modules written as <Value>' -ForEach @(
            @{ Value = 'PSDscResources' }
            @{ Value = 'PSDscResources@2.12.0.0' }
            @{ Value = "A@1.0.0`nB@2.0" }
            @{ Value = "A@1.0.0`r`nB@2.0`r`n" }
            @{ Value = 'A@1.0.0,B@2.0 ,  C.D-E_F@3.0.0-preview1' }
        ) {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'resource-modules' = $Value } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
        }

        It 'Rejects the resource-modules entry <Value>' -ForEach @(
            @{ Value = 'A@' }, @{ Value = '@1.0.0' }, @{ Value = 'A@1' }, @{ Value = 'A B' }, @{ Value = 'A@1.0;calc' }, @{ Value = '../A' }
        ) {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'resource-modules' = $Value } -PreflightOnly
            $Result.Status | Should -Be 'InvalidSettings'
            $Text | Should -Match "'resource-modules' entry"
        }

        It 'Rejects a module-repository that is not a plain name' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-repository' = 'https://feed.example.test/' } -PreflightOnly
            $Text | Should -Match "'module-repository' is not a valid repository name"
        }

        It 'Rejects an Azure DevOps token in the wrong format without printing it' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; connect = 'AzureDevOps'; 'azure-devops-organization' = 'Contoso'; 'azure-devops-token' = 'not a token!' }
            $Result.Status | Should -Be 'InvalidSettings'
            $Text | Should -Match "'azure-devops-token' is not in the expected format"
            $Text | Should -Not -Match 'not a token!'
        }

        It 'Rejects <Setting> = <Value>' -ForEach @(
            @{ Setting = 'engine'; Value = 'DscV4' }
            @{ Setting = 'connect'; Value = 'GitHub' }
            @{ Setting = 'fail-on-error'; Value = 'yes' }
            @{ Setting = 'azure-devops-authentication'; Value = 'Kerberos' }
            @{ Setting = 'module-source'; Value = 'Fork' }
            @{ Setting = 'skip-module-install'; Value = '1' }
        ) {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; $Setting = $Value } -PreflightOnly
            $Result.Status | Should -Be 'InvalidSettings'
            $Text | Should -Match "'$Setting' is '$Value'\. Allowed values:"
        }

        It 'Treats a setting that is only white space as not set' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; mode = '   '; engine = '' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
            $Result.Mode | Should -Be 'Test'
        }
    }

    Context 'Warnings' {

        It 'Warns that <About>' -ForEach @(
            @{ About = 'Set changes systems'; Setting = @{ mode = 'Set' }; Expect = "'mode' is Set: this run changes the systems" }
            @{ About = 'Azure DevOps settings are ignored without connect'; Setting = @{ 'azure-devops-organization' = 'Contoso' }; Expect = "Azure DevOps settings are set but 'connect' is None" }
            @{ About = 'a revision is ignored for a local path'; Setting = @{ 'configuration-revision' = 'main' }; Expect = "only apply with 'configuration-repository-url'" }
            @{ About = 'a source ref is ignored for the gallery'; Setting = @{ 'module-source-ref' = 'main' }; Expect = "'module-source-ref' is set but 'module-source' is Gallery" }
        ) {
            Invoke-Step -Setting (@{ 'configuration-path' = $Config } + $Setting) -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
            $Text | Should -Match $Expect
            $Result.Warnings -join "`n" | Should -Match $Expect
        }

        It 'Warns when a cloned configuration is not pinned to a revision' {
            if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { Set-ItResult -Skipped -Because 'git is not installed here'; return }
            Invoke-Step -Setting @{ 'configuration-repository-url' = 'https://example.test/c.git' } -PreflightOnly
            $Text | Should -Match "'configuration-revision' is empty"
        }

        It 'Says nothing about pinning when everything is pinned' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '9.9.9'; 'resource-modules' = 'DscprTestDependency@1.0.0' } -PreflightOnly
            $Text | Should -Not -Match 'Pin '
            if ($IsWindows) { $Result.Warnings | Should -BeNullOrEmpty }
        }

        It 'Warns that DSC v2 needs Windows when it is run anywhere else' {
            if ($IsWindows) { Set-ItResult -Skipped -Because 'this is a Windows agent'; return }
            Invoke-Step -Setting @{ 'configuration-path' = $Config; engine = 'DscV2'; mode = 'DryRun' } -PreflightOnly
            $Text | Should -Match 'DSC v2 needs the OMI library \(libmi\)'
        }
    }

    Context 'What it leaves behind' {

        It 'Keeps secrets out of result.json and outputs.env' {
            if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { Set-ItResult -Skipped -Because 'git is not installed here'; return }
            Invoke-Step -Setting @{ 'configuration-repository-url' = 'https://example.test/c.git'; 'source-token' = 'super-secret-value-123' }
            $Result.Status | Should -Be 'Completed'
            foreach ($file in 'result.json', 'outputs.env') {
                Get-Content -LiteralPath (Join-Path $Reports $file) -Raw | Should -Not -Match 'super-secret-value-123'
            }
        }

        It 'Writes a result for a run that could not start' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'resource-modules' = 'NotOnThisAgent@1.0.0' }
            $written = Get-Content -LiteralPath (Join-Path $Reports 'result.json') -Raw | ConvertFrom-Json
            $written.Status | Should -Be 'Aborted'
            $written.Problems -join ' ' | Should -Match 'NotOnThisAgent'
            Get-Content -LiteralPath (Join-Path $Reports 'outputs.env') | Should -Contain 'DSCPR_STATUS=Aborted'
        }

        It 'Reports the runner''s own counts and status <Status>' -ForEach @(
            @{ Status = 'Completed'; Fail = 0 }, @{ Status = 'PartialSuccess'; Fail = 0 }, @{ Status = 'Failed'; Fail = 1 }
        ) {
            $env:DSCPR_TEST_STATUS = $Status
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'fail-on-error' = 'false' }
            $Result.Status | Should -Be $Status
            $Result.TotalResources | Should -Be 3
            $Result.FailCount | Should -Be $Fail
            $Result.PassCount | Should -Be (3 - $Fail)
        }

        It 'Fails clearly when the runner returns no summary' {
            $env:DSCPR_TEST_NO_SUMMARY = '1'
            Invoke-Step -Setting @{ 'configuration-path' = $Config }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'returned no run summary'
        }

        It 'Keeps every output on one line' {
            $env:DSCPR_TEST_STATUS = "Completed`nDSCPR_INJECTED=1"
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'fail-on-error' = 'false' }
            $lines = Get-Content -LiteralPath (Join-Path $Reports 'outputs.env')
            $lines | Where-Object { $_ -match '^DSCPR_INJECTED' } | Should -BeNullOrEmpty
            $lines.Count | Should -Be 7
        }

        It 'Stops after the checks with PreflightOnly: nothing installed, nothing run, no result files' {
            Mock Install-Module { }
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '1.2.3' } -PreflightOnly
            $Result.Status | Should -Be 'PreflightPassed'
            $Call | Should -BeNullOrEmpty
            Should -Invoke Install-Module -Times 0
            Test-Path -LiteralPath (Join-Path $Reports 'result.json') | Should -BeFalse
        }

        It 'Exits <Code> when <When>' -ForEach @(
            @{ Code = 0; When = 'the run completes'; Status = 'Completed'; Setting = '' }
            @{ Code = 0; When = 'the run is a partial success'; Status = 'PartialSuccess'; Setting = '' }
            @{ Code = 1; When = 'the run failed'; Status = 'Failed'; Setting = '' }
            @{ Code = 0; When = 'the run failed and fail-on-error is false'; Status = 'Failed'; Setting = "; 'fail-on-error' = 'false'" }
            @{ Code = 1; When = 'the run was aborted by the runner'; Status = 'Aborted'; Setting = '' }
        ) {
            $env:DSCPR_TEST_STATUS = $Status
            pwsh -NoProfile -Command "& '$Step' -Setting @{ 'configuration-path' = '$Config'; 'skip-module-install' = 'true'; 'report-path' = '$Reports'$Setting } -Platform generic; exit `$LASTEXITCODE" | Out-Null
            $LASTEXITCODE | Should -Be $Code
        }
    }
}
