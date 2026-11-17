#requires -Version 7.0
# Installing and choosing modules (module-source: Gallery). Install-Module and Install-PSResource
# are mocked, so nothing here reaches a module repository.

BeforeAll {
    . (Join-Path $PSScriptRoot 'TestHelpers.ps1')
    Save-StepTestEnvironment
}

AfterAll { Restore-StepTestEnvironment }

Describe 'Installing modules' {

    BeforeEach {
        Reset-StepTestState
        Mock Install-Module { }
        Mock Install-PSResource { }
        Mock Start-Sleep { }
    }

    Context 'Dsc.PipelineRunner' {

        It 'Installs nothing when the pinned version is already on the agent' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '9.9.9' }
            $Result.Status | Should -Be 'Completed'
            $Result.ModuleVersion | Should -Be '9.9.9'
            Should -Invoke Install-Module -Times 0
            $Text | Should -Match 'Dsc\.PipelineRunner 9\.9\.9 is already installed'
        }

        It 'Installs nothing when no version is asked for and one is already on the agent' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false' }
            $Result.Status | Should -Be 'Completed'
            Should -Invoke Install-Module -Times 0
        }

        It 'Installs the exact version asked for, for the current user, from the chosen repository' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '1.2.3'; 'module-repository' = 'InternalFeed' }
            Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter {
                $Name -eq 'Dsc.PipelineRunner' -and $RequiredVersion -eq '1.2.3' -and $Repository -eq 'InternalFeed' -and $Scope -eq 'CurrentUser' -and -not $AllowPrerelease
            }
        }

        It 'Asks for a preview only when allow-prerelease is true' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '1.3.0-preview1'; 'allow-prerelease' = 'true' }
            Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $Name -eq 'Dsc.PipelineRunner' -and $RequiredVersion -eq '1.3.0-preview1' -and $AllowPrerelease }
        }

        It 'Says so when the version it installed still cannot be imported' {
            # The mock installs nothing, so 1.2.3 is still not there.
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '1.2.3' }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'could not be imported'
            $Call | Should -BeNullOrEmpty
        }

        It 'Runs the version that is pinned when several are on the agent' {
            $env:PSModulePath = $FixtureModules + [System.IO.Path]::PathSeparator + $OldFixtureModules + [System.IO.Path]::PathSeparator + $BasePSModulePath
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = '1.0.0' }
            $Result.ModuleVersion | Should -Be '1.0.0'
            $Call.ModuleVersion | Should -Be '1.0.0'

            Reset-StepTestState
            $env:PSModulePath = $FixtureModules + [System.IO.Path]::PathSeparator + $OldFixtureModules + [System.IO.Path]::PathSeparator + $BasePSModulePath
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = '9.9.9' }
            $Call.ModuleVersion | Should -Be '9.9.9'
        }

        It 'Replaces a different version that is already loaded in the session' {
            Import-Module (Join-Path $OldFixtureModules 'Dsc.PipelineRunner/Dsc.PipelineRunner.psd1') -Force
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'module-version' = '9.9.9' }
            $Call.ModuleVersion | Should -Be '9.9.9'
            @(Get-Module -Name 'Dsc.PipelineRunner').Count | Should -Be 1
        }

        It 'Refuses DryRun on a module that does not have it, and says what to do' {
            $env:PSModulePath = $OldFixtureModules + [System.IO.Path]::PathSeparator + $BasePSModulePath
            Invoke-Step -Setting @{ 'configuration-path' = $Config; mode = 'DryRun' }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match "'mode' is DryRun, but Dsc\.PipelineRunner 1\.0\.0 does not support it"
            $Text | Should -Match 'module-source: Repository'
            $Call | Should -BeNullOrEmpty
        }
    }

    Context 'Resource modules' {

        It 'Installs each one that is missing at its pinned version, and skips those already there' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'resource-modules' = "DscprTestDependency@1.0.0`nNotOnThisAgent@2.0.0, AlsoMissing@3.1.4.1" }
            Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $Name -eq 'NotOnThisAgent' -and $RequiredVersion -eq '2.0.0' }
            Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $Name -eq 'AlsoMissing' -and $RequiredVersion -eq '3.1.4.1' }
            Should -Invoke Install-Module -Times 0 -ParameterFilter { $Name -eq 'DscprTestDependency' }
        }

        It 'Stops before the run and names every module that is still missing' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'resource-modules' = 'NotOnThisAgent@2.0.0, AlsoMissing@3.0.0' }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'Required module\(s\) are not installed on the agent: NotOnThisAgent; AlsoMissing'
            $Call | Should -BeNullOrEmpty
        }

        It 'Installs a module without a version only when it is not there at all' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'resource-modules' = 'DscprTestDependency, NotOnThisAgent' }
            Should -Invoke Install-Module -Times 0 -ParameterFilter { $Name -eq 'DscprTestDependency' }
            Should -Invoke Install-Module -Times 1 -Exactly -ParameterFilter { $Name -eq 'NotOnThisAgent' -and -not $RequiredVersion }
        }
    }

    Context 'skip-module-install' {

        It 'Installs nothing at all' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'true'; 'module-version' = '9.9.9'; 'resource-modules' = 'DscprTestDependency@1.0.0' }
            $Result.Status | Should -Be 'Completed'
            Should -Invoke Install-Module -Times 0
            Should -Invoke Install-PSResource -Times 0
        }

        It 'Names a module that is not on the agent instead of trying to install it' {
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'true'; 'resource-modules' = 'NotOnThisAgent@2.0.0' }
            $Result.Status | Should -Be 'Aborted'
            $Text | Should -Match 'Required module\(s\) are not installed on the agent: NotOnThisAgent'
            Should -Invoke Install-Module -Times 0
        }
    }

    Context 'A failing module repository' {

        It 'Tries three times, waits between tries, then fails with the reason' {
            Mock Install-Module { throw 'the feed is down' }
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'module-version' = '1.2.3' }
            $Result.Status | Should -Be 'Aborted'
            Should -Invoke Install-Module -Times 3 -Exactly
            Should -Invoke Start-Sleep -Times 2 -Exactly
            $Text | Should -Match "Could not install module 'Dsc\.PipelineRunner' 1\.2\.3 from repository 'PSGallery' after 3 attempts: the feed is down"
        }

        It 'Carries on after a try that fails and a retry that works' {
            $script:Attempts = 0
            Mock Install-Module { $script:Attempts++; if ($script:Attempts -eq 1) { throw 'a blip' } }
            Invoke-Step -Setting @{ 'configuration-path' = $Config; 'skip-module-install' = 'false'; 'resource-modules' = 'NotOnThisAgent@2.0.0' }
            Should -Invoke Install-Module -Times 2 -Exactly
            $Text | Should -Match 'Attempt 1 to install NotOnThisAgent failed; retrying'
            $Text | Should -Match 'Installed NotOnThisAgent 2\.0\.0 from PSGallery'
        }
    }
}
