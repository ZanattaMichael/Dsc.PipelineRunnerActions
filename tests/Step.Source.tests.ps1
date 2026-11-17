#requires -Version 7.0
# Building and running the module from its source repository (module-source: Repository).
# The "source repository" is a local git repository made by New-SourceRepository, so these tests
# clone, check out, build and import for real without touching the network.

BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    Save-StepTestEnvironment

    $script:HasGit = [bool](Get-Command git -CommandType Application -ErrorAction SilentlyContinue)
    if ($script:HasGit) {
        $script:Repository = New-SourceRepository -Path (Join-Path $TestDrive 'source-repository')
        $script:MainCommit = (& git -C $script:Repository rev-parse main).Trim()
    }

    function Invoke-SourceStep {
        param([string] $Ref, [hashtable] $Setting = @{})
        $base = @{
            'configuration-path'       = $script:Config
            'skip-module-install'      = 'false'
            'module-source'            = 'Repository'
            'module-source-repository' = $script:Repository
            'module-source-ref'        = $Ref
        }
        foreach ($key in $Setting.Keys) { $base[$key] = $Setting[$key] }
        Invoke-Step -Setting $base
    }
}

AfterAll { Restore-StepTestEnvironment }

Describe 'Module from the source repository' -Skip:(-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) {

    BeforeEach {
        Reset-StepTestState
        $env:DSCPR_TEST_MARKER = Join-Path $TestDrive ([guid]::NewGuid().ToString('N') + '.marker')
        # Nothing in these tests may reach a module repository.
        Mock Install-Module { throw 'Install-Module must not be called in this test.' }
    }

    Context 'Which commit is built' {

        It 'Builds the default branch by name and runs the build it made' {
            Invoke-SourceStep -Ref 'main'
            $Result.Status | Should -Be 'Completed'
            $Result.ModuleVersion | Should -Be '7.7.7'
            $Call.ModuleVersion | Should -Be '7.7.7' -Because 'the runner that ran must be the one that was built, not the installed 9.9.9'
            $Text | Should -Match "Building commit $MainCommit"
        }

        It 'Builds a branch that is not the default branch' {
            Invoke-SourceStep -Ref 'deps'
            $Result.Status | Should -Be 'Completed'
            $Text | Should -Not -Match "Building commit $MainCommit"
        }

        It 'Builds a tag' {
            Invoke-SourceStep -Ref 'v7.7.7'
            $Result.Status | Should -Be 'Completed'
            $Text | Should -Match "Building commit $MainCommit"
        }

        It 'Builds a full commit SHA and does not warn that it is unpinned' {
            Invoke-SourceStep -Ref $MainCommit
            $Result.Status | Should -Be 'Completed'
            $Text | Should -Match "Building commit $MainCommit"
            $Text | Should -Not -Match 'is not a full commit SHA'
        }

        It 'Fails clearly for a ref that does not exist' {
            Invoke-SourceStep -Ref 'no-such-branch'
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match "Could not find 'no-such-branch' in the module source repository"
            $Call | Should -BeNullOrEmpty
        }

        It 'Fails clearly for a commit SHA that is not in the repository' {
            Invoke-SourceStep -Ref ('0' * 40)
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'Could not find'
        }

        It 'Fails clearly when the repository cannot be cloned' {
            Invoke-SourceStep -Ref 'main' -Setting @{ 'module-source-repository' = (Join-Path $TestDrive 'not-a-repository') }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'Could not clone the module source repository'
        }
    }

    Context 'The build' {

        It 'Runs the build script with -ResolveDependency -Tasks build' {
            Invoke-SourceStep -Ref 'main'
            $Text | Should -Match 'fixture build: ResolveDependency=True Tasks=build'
        }

        It 'Finds Build.ps1 whatever its letter case, and a build that writes to Output' {
            Invoke-SourceStep -Ref 'capital'
            $Result.Status | Should -Be 'Completed'
            $Result.ModuleVersion | Should -Be '7.7.7'
        }

        It 'Fails when the repository has no build script' {
            Invoke-SourceStep -Ref 'no-build'
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'has no build\.ps1'
        }

        It 'Fails with the exit code when the build fails, and shows the build output' {
            Invoke-SourceStep -Ref 'build-fails'
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'Building the module from source failed \(exit code 3\)'
            $Text | Should -Match 'the fixture build is failing'
        }

        It 'Fails when the build produces no module' {
            Invoke-SourceStep -Ref 'build-empty'
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'produced no Dsc\.PipelineRunner module'
        }
    }

    Context 'Run-time dependencies of the built module' {

        It 'Uses the repository''s pinned installer when the commit has one' {
            Invoke-SourceStep -Ref 'pinned'
            $Result.Status | Should -Be 'Completed'
            Get-Content -LiteralPath $env:DSCPR_TEST_MARKER | Should -Be 'DscprTestDependency'
            Should -Invoke Install-Module -Times 0
        }

        It 'Does not install a dependency that is already on the agent' {
            Invoke-SourceStep -Ref 'deps'
            $Result.Status | Should -Be 'Completed'
            Should -Invoke Install-Module -Times 0
            Test-Path -LiteralPath $env:DSCPR_TEST_MARKER | Should -BeFalse
        }

        It 'Installs nothing for a module with no dependencies' {
            Invoke-SourceStep -Ref 'main'
            Should -Invoke Install-Module -Times 0
        }

        It 'Still installs the resource modules that were asked for' {
            Mock Install-Module { }
            Invoke-SourceStep -Ref 'main' -Setting @{ 'resource-modules' = 'NotOnThisAgent@2.0.0' }
            Should -Invoke Install-Module -Times 1 -ParameterFilter { $Name -eq 'NotOnThisAgent' -and $RequiredVersion -eq '2.0.0' }
            Should -Invoke Install-Module -Times 0 -ParameterFilter { $Name -eq 'Dsc.PipelineRunner' }
        }
    }

    Context 'What is reported' {

        It 'Reports the built version in the outputs and ignores module-version' {
            Invoke-SourceStep -Ref 'main' -Setting @{ 'module-version' = '1.2.1' }
            $Result.ModuleVersion | Should -Be '7.7.7'
            Get-Content -LiteralPath (Join-Path $Reports 'outputs.env') | Should -Contain 'DSCPR_MODULE_VERSION=7.7.7'
            $Text | Should -Match "'module-version' is ignored"
        }

        It 'Passes the settings on to the runner it built' {
            Invoke-SourceStep -Ref 'main' -Setting @{ mode = 'DryRun'; engine = 'DscV2' }
            $Call.Mode | Should -Be 'DryRun'
            $Call.ConfigurationSourcePath | Should -Be (Resolve-Path $Config).Path
        }

        It 'Leaves the working directory and the caller''s module path alone' {
            $before = (Get-Location).Path
            $modulePath = $env:PSModulePath
            Invoke-SourceStep -Ref 'main'
            (Get-Location).Path | Should -Be $before
            $env:PSModulePath | Should -Be $modulePath
        }
    }
}
