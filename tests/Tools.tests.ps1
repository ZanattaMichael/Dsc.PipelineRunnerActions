#requires -Version 7.0
# The maintenance scripts in tools/. Each test works on a copy of the files in TestDrive, so the
# repository itself is never changed by a test run.

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot

    function New-RepositoryCopy {
        $copy = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
        $null = New-Item -ItemType Directory -Path $copy
        foreach ($folder in 'tools', 'core', 'azure-devops', 'jenkins', 'docs') {
            Copy-Item -LiteralPath (Join-Path $script:Root $folder) -Destination (Join-Path $copy $folder) -Recurse
        }
        return $copy
    }
}

Describe 'tools/Set-AzureDevOpsVersion.ps1' {

    BeforeEach {
        $script:Copy = New-RepositoryCopy
        $script:TaskPath = Join-Path $Copy 'azure-devops/DscPipelineRunnerTask/task.json'
        $script:ManifestPath = Join-Path $Copy 'azure-devops/vss-extension.json'
        $script:TaskBefore = Get-Content -LiteralPath $TaskPath -Raw | ConvertFrom-Json
    }

    It 'Writes the version into the task and the extension manifest' {
        & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version '1.4.2' | Out-Null
        $task = Get-Content -LiteralPath $TaskPath -Raw | ConvertFrom-Json
        $task.version.Major | Should -Be 1
        $task.version.Minor | Should -Be 4
        $task.version.Patch | Should -Be 2
        (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).version | Should -Be '1.4.2'
    }

    It 'Changes nothing else in the task' {
        & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version '1.4.2' | Out-Null
        $task = Get-Content -LiteralPath $TaskPath -Raw | ConvertFrom-Json
        $task.id | Should -Be $TaskBefore.id
        $task.inputs.Count | Should -Be $TaskBefore.inputs.Count
        ($task.inputs | ConvertTo-Json -Depth 10) | Should -Be ($TaskBefore.inputs | ConvertTo-Json -Depth 10)
        ($task.execution | ConvertTo-Json -Depth 10) | Should -Be ($TaskBefore.execution | ConvertTo-Json -Depth 10)
        $task.outputVariables.Count | Should -Be $TaskBefore.outputVariables.Count
    }

    It 'Keeps the extension private and its publisher unless told otherwise' {
        $publisher = (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).publisher
        & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version '1.0.0' | Out-Null
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        $manifest.public | Should -BeFalse
        $manifest.publisher | Should -Be $publisher
    }

    It 'Sets the publisher and makes the extension public when asked' {
        & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version '2.0.0' -Publisher 'my-publisher' -Public | Out-Null
        $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
        $manifest.public | Should -BeTrue
        $manifest.publisher | Should -Be 'my-publisher'
        $manifest.contributions[0].properties.name | Should -Be 'DscPipelineRunnerTask'
    }

    It 'Rejects the version <_>' -ForEach 'v1.0.0', '1.0', '1.0.0.0', '1.0.0-preview1', '' {
        { & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version $_ } | Should -Throw
        (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).version | Should -Be '0.0.0'
    }

    It 'Rejects a publisher that is not a plain identifier' {
        { & (Join-Path $Copy 'tools/Set-AzureDevOpsVersion.ps1') -Version '1.0.0' -Publisher 'my publisher' } | Should -Throw
    }
}

Describe 'tools/Sync-Core.ps1' {

    BeforeEach { $script:Copy = New-RepositoryCopy }

    It 'Brings the Jenkins copy back in step with core/' {
        Add-Content -LiteralPath (Join-Path $Copy 'core/Invoke-DscPipelineRunnerStep.ps1') -Value '# a change'
        Add-Content -LiteralPath (Join-Path $Copy 'core/settings.json') -Value ' '
        & (Join-Path $Copy 'tools/Sync-Core.ps1') | Out-Null
        foreach ($file in 'Invoke-DscPipelineRunnerStep.ps1', 'settings.json') {
            Get-Content -LiteralPath (Join-Path $Copy "jenkins/resources/dsc-pipeline-runner/$file") -Raw |
                Should -Be (Get-Content -LiteralPath (Join-Path $Copy "core/$file") -Raw)
        }
    }

    It 'Does not create the Azure DevOps copy unless asked' {
        & (Join-Path $Copy 'tools/Sync-Core.ps1') | Out-Null
        Test-Path -LiteralPath (Join-Path $Copy 'azure-devops/DscPipelineRunnerTask/core') | Should -BeFalse
    }

    It 'Copies core/ into the Azure DevOps task with -AzureDevOps, where index.js looks for it' {
        & (Join-Path $Copy 'tools/Sync-Core.ps1') -AzureDevOps | Out-Null
        foreach ($file in 'Invoke-DscPipelineRunnerStep.ps1', 'settings.json') {
            Test-Path -LiteralPath (Join-Path $Copy "azure-devops/DscPipelineRunnerTask/core/$file") | Should -BeTrue
        }
        Get-Content -LiteralPath (Join-Path $Copy 'azure-devops/DscPipelineRunnerTask/index.js') -Raw |
            Should -Match "path\.join\(__dirname, 'core', 'Invoke-DscPipelineRunnerStep\.ps1'\)"
    }
}

Describe 'tools/Build-SettingsDoc.ps1' {

    BeforeAll {
        $script:Definition = Get-Content -LiteralPath (Join-Path $Root 'core/settings.json') -Raw | ConvertFrom-Json
        $script:Document = & (Join-Path $Root 'tools/Build-SettingsDoc.ps1') -PassThru
    }

    It 'Has a section for every group of settings' {
        foreach ($group in ($Definition.settings.group | Select-Object -Unique)) { $Document | Should -Match "(?m)^## $([regex]::Escape($group))$" }
    }

    It 'Lists every setting with its default and its allowed values' {
        foreach ($setting in $Definition.settings) {
            $default = if ($setting.default) { [regex]::Escape(('`{0}`' -f $setting.default)) } else { '\(empty\)' }
            $Document | Should -Match "(?m)^\| ``$([regex]::Escape($setting.name))``( \(secret\))? \| $default \| "
            if ($setting.PSObject.Properties['values']) {
                foreach ($value in $setting.values) { $Document | Should -Match ([regex]::Escape(('`{0}`' -f $value))) }
            }
        }
    }

    It 'Marks exactly the secret settings as secret' {
        $marked = [regex]::Matches($Document, '(?m)^\| `([a-z-]+)` \(secret\) \|') | ForEach-Object { $_.Groups[1].Value }
        $marked | Sort-Object | Should -Be ($Definition.settings | Where-Object secret | ForEach-Object name | Sort-Object)
    }

    It 'Lists every output and how to read it on each platform' {
        foreach ($output in $Definition.outputs) { $Document | Should -Match ([regex]::Escape(('| `{0}` |' -f $output.name))) }
        foreach ($platform in 'GitHub Actions', 'Azure DevOps', 'GitLab', 'CircleCI', 'Jenkins') { $Document | Should -Match "(?m)^\| $platform \| " }
    }

    It 'Writes docs/settings.md when not asked to pass the text through' {
        $copy = New-RepositoryCopy
        Remove-Item -LiteralPath (Join-Path $copy 'docs/settings.md')
        & (Join-Path $copy 'tools/Build-SettingsDoc.ps1') | Out-Null
        (Get-Content -LiteralPath (Join-Path $copy 'docs/settings.md') -Raw) -replace '\r\n', "`n" | Should -Be $Document
    }
}

Describe 'core/settings.json' {

    BeforeAll { $script:Definition = Get-Content -LiteralPath (Join-Path $Root 'core/settings.json') -Raw | ConvertFrom-Json }

    It 'Has unique names and unique environment variables' {
        ($Definition.settings.name | Group-Object | Where-Object Count -GT 1).Name | Should -BeNullOrEmpty
        ($Definition.settings.env | Group-Object | Where-Object Count -GT 1).Name | Should -BeNullOrEmpty
    }

    It 'Names every environment variable after its setting' {
        foreach ($setting in $Definition.settings) { $setting.env | Should -Be ('DSCPR_' + ($setting.name.ToUpperInvariant() -replace '-', '_')) }
    }

    It 'Gives every setting a group and a description that ends in a full stop' {
        foreach ($setting in $Definition.settings) {
            $setting.group | Should -Not -BeNullOrEmpty
            $setting.description | Should -Match '\.$'
        }
    }

    It 'Has a default that is one of the allowed values, where there are allowed values' {
        foreach ($setting in ($Definition.settings | Where-Object { $_.PSObject.Properties['values'] })) { $setting.values | Should -Contain $setting.default }
    }

    It 'Never gives a secret a default' {
        foreach ($setting in ($Definition.settings | Where-Object secret)) { $setting.default | Should -BeNullOrEmpty }
    }

    It 'Is the exact list the step script reads' {
        $script = Get-Content -LiteralPath (Join-Path $Root 'core/Invoke-DscPipelineRunnerStep.ps1') -Raw
        $used = [regex]::Matches($script, "\`$settings\['([a-z-]+)'\]|Test-Flag '([a-z-]+)'") | ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value } } | Sort-Object -Unique
        foreach ($name in $used) { $Definition.settings.name | Should -Contain $name -Because "the step reads '$name'" }
        foreach ($name in $Definition.settings.name) { $used | Should -Contain $name -Because "'$name' is declared but the step never reads it" }
    }
}
