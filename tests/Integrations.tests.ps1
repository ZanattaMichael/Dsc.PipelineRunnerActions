#requires -Version 7.0
# Every integration must offer every setting in core/settings.json, with the same default, and the
# documentation must list them. These tests are what keeps the integrations in step.

BeforeDiscovery {
    $root = Split-Path -Parent $PSScriptRoot
    $definition = Get-Content -LiteralPath (Join-Path $root 'core/settings.json') -Raw | ConvertFrom-Json
    $script:SettingCases = foreach ($item in $definition.settings) {
        $parts = $item.name -split '-'
        @{
            Name    = $item.name
            Camel   = $parts[0] + (($parts | Select-Object -Skip 1 | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }) -join '')
            Snake   = $item.name -replace '-', '_'
            EnvName = $item.env
            Default = [string]$item.default
            Secret  = [bool]$item.secret
        }
    }
    $script:OutputCases = foreach ($item in $definition.outputs) { @{ Name = $item.name } }
}

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot
    function Get-RepoText { param([string] $Path) Get-Content -LiteralPath (Join-Path $script:Root $Path) -Raw }
    $script:Action = Get-RepoText 'action.yml'
    $script:Task = Get-RepoText 'azure-devops/DscPipelineRunnerTask/task.json' | ConvertFrom-Json
    $script:TaskScript = Get-RepoText 'azure-devops/DscPipelineRunnerTask/index.js'
    $script:GitLab = Get-RepoText 'templates/dsc-pipeline-runner.yml'
    $script:Orb = Get-RepoText 'circleci/orb.yml'
    $script:Jenkins = Get-RepoText 'jenkins/vars/dscPipelineRunner.groovy'
    $script:SettingsDoc = Get-RepoText 'docs/settings.md'
}

Describe 'Every integration exposes every setting' {

    It 'GitHub Action has input <Name> with the documented default, passed as <EnvName>' -ForEach $SettingCases {
        $Action | Should -Match "(?m)^  $([regex]::Escape($Name)):\r?\n    description: .+\r?\n    required: false\r?\n    default: '$([regex]::Escape($Default))'"
        $Action | Should -Match "(?m)^\s+${EnvName}: \`$\{\{ inputs\.$([regex]::Escape($Name)) \}\}"
    }

    It 'Azure DevOps task has input <Camel> with the documented default, mapped to <EnvName>' -ForEach $SettingCases {
        $taskInput = $Task.inputs | Where-Object name -EQ $Camel
        $taskInput | Should -Not -BeNullOrEmpty
        ([string]$taskInput.defaultValue).ToLowerInvariant() | Should -Be $Default.ToLowerInvariant()
        $taskInput.helpMarkDown | Should -Not -BeNullOrEmpty
        $TaskScript | Should -Match "\['$Camel', '$EnvName', $("$Secret".ToLowerInvariant())\]"
    }

    It 'GitLab component has input <Snake> (or reads the secret variable <EnvName>)' -ForEach $SettingCases {
        if ($Secret) {
            $GitLab | Should -Match "(?m)^#\s+$EnvName\s"
            $GitLab | Should -Not -Match "(?m)^    $($Snake):"
        }
        else {
            $GitLab | Should -Match "(?m)^    $($Snake):\r?\n      description: .+\r?\n      default: '$([regex]::Escape($Default))'"
            $GitLab | Should -Match "(?m)^    ${EnvName}: '\`$\[\[ inputs\.$Snake \]\]'"
        }
    }

    It 'CircleCI orb has parameter <Name> on the command and the job' -ForEach $SettingCases {
        $parameter = if ($Secret) { "$Name-variable" } else { $Name }
        ([regex]::Matches($Orb, "(?m)^      $([regex]::Escape($parameter)):\r?\n        description: ")).Count | Should -Be 2
        $Orb | Should -Match "(?m)^          $([regex]::Escape($parameter)): << parameters\.$([regex]::Escape($parameter)) >>"
        if ($Secret) { $Orb | Should -Match "default: $EnvName" }
    }

    It 'Jenkins step knows setting <Camel>' -ForEach $SettingCases {
        $Jenkins | Should -Match "\[name: '$Camel', env: '$EnvName', secret: $("$Secret".ToLowerInvariant())\]"
    }

    It 'docs/settings.md describes <Name>' -ForEach $SettingCases {
        $SettingsDoc | Should -Match ([regex]::Escape("``$Name``"))
    }

    It 'Output <Name> is declared by the GitHub Action and the Azure DevOps task' -ForEach $OutputCases {
        $Action | Should -Match "steps\.run\.outputs\.$([regex]::Escape($Name)) "
        $Task.outputVariables.name | Should -Contain ($Name -replace '-', '_')
    }
}

Describe 'Generated and copied files are current' {

    It 'docs/settings.md is what tools/Build-SettingsDoc.ps1 produces' {
        $expected = & (Join-Path $Root 'tools/Build-SettingsDoc.ps1') -PassThru
        ($SettingsDoc -replace '\r\n', "`n") | Should -Be $expected -Because 'run tools/Build-SettingsDoc.ps1 after changing core/settings.json'
    }

    It 'The Jenkins copy of core/<_> is identical to core/' -ForEach 'Invoke-DscPipelineRunnerStep.ps1', 'settings.json' {
        $copy = (Get-RepoText "jenkins/resources/dsc-pipeline-runner/$_") -replace '\r\n', "`n"
        $core = (Get-RepoText "core/$_") -replace '\r\n', "`n"
        $copy | Should -Be $core -Because 'run tools/Sync-Core.ps1 after changing core/'
    }
}

Describe 'Logos' {

    It 'Has a light SVG, a dark SVG and a PNG for <_>' -ForEach 'logo', 'logo-github-actions', 'logo-azure-devops', 'logo-gitlab', 'logo-circleci', 'logo-jenkins', 'logo-generic' {
        foreach ($file in "$_.svg", "$_-dark.svg", "$_-512.png") {
            Test-Path (Join-Path $Root "assets/$file") | Should -BeTrue -Because "assets/$file is part of the logo family (tools/build-logos.js)"
        }
        [xml](Get-RepoText "assets/$_.svg") | Should -Not -BeNullOrEmpty
    }
}

Describe 'Platform rules' {

    It 'GitHub Action: inputs are passed through env, never written into the script' {
        $runBlock = $Action.Substring($Action.IndexOf('      run: |'))
        $runBlock | Should -Not -Match '\$\{\{'
    }

    It 'GitHub Action: Marketplace metadata is present and the description is short enough' {
        $Action | Should -Match '(?m)^name: '
        $Action | Should -Match '(?m)^branding:'
        ([regex]::Match($Action, '(?m)^description: (.+)$').Groups[1].Value.Length) | Should -BeLessThan 125
    }

    It 'Azure DevOps task: ids, handler and manifest agree' {
        $Task.id | Should -Match '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        $Task.execution.PSObject.Properties.Name | Should -Contain 'Node20_1'
        $manifest = Get-RepoText 'azure-devops/vss-extension.json' | ConvertFrom-Json
        $contribution = $manifest.contributions | Where-Object type -EQ 'ms.vss-distributed-task.task'
        $contribution.properties.name | Should -Be 'DscPipelineRunnerTask'
        $manifest.files.path | Should -Contain 'DscPipelineRunnerTask'
        Test-Path (Join-Path $Root "azure-devops/$($manifest.icons.default)") | Should -BeTrue
    }

    It 'No integration carries a secret as a plain setting' {
        $GitLab | Should -Not -Match 'inputs\.(source_token|azure_devops_token)'
        $Orb | Should -Not -Match '(?m)^      (source-token|azure-devops-token):'
        $Jenkins | Should -Match 'withCredentials'
    }

    It 'The fetched step script is pinned by the published CircleCI orb, not left as a placeholder in a release' {
        # The placeholder is replaced with the release commit by the publish pipeline.
        $Orb | Should -Match "default: '__DSCPR_ACTIONS_REF__'"
        (Get-RepoText '.github/workflows/publish-circleci.yml') | Should -Match '__DSCPR_ACTIONS_REF__'
    }
}
