#requires -Version 7.0
# The example pipelines and the snippets in the documentation must only use settings that exist,
# spelled the way that platform spells them. A renamed or removed setting fails here, not in a
# user's pipeline.

BeforeDiscovery {
    $root = Split-Path -Parent $PSScriptRoot
    $script:ExampleFiles = Get-ChildItem -Path (Join-Path $root 'examples') -Recurse -File -Force | ForEach-Object { @{ Path = $_.FullName; Name = $_.FullName.Substring($root.Length + 1) -replace '\\', '/' } }
    $script:DocFiles = @(Get-ChildItem -Path (Join-Path $root 'docs') -Filter '*.md') + @(Get-Item (Join-Path $root 'README.md'), (Join-Path $root 'azure-devops/overview.md')) |
        ForEach-Object { @{ Path = $_.FullName; Name = $_.FullName.Substring($root.Length + 1) -replace '\\', '/' } }
}

BeforeAll {
    $script:Root = Split-Path -Parent $PSScriptRoot
    $definition = Get-Content -LiteralPath (Join-Path $Root 'core/settings.json') -Raw | ConvertFrom-Json

    $camel = { param($name) $parts = $name -split '-'; $parts[0] + (($parts | Select-Object -Skip 1 | ForEach-Object { $_.Substring(0, 1).ToUpperInvariant() + $_.Substring(1) }) -join '') }
    $plain = $definition.settings | Where-Object { -not $_.secret }
    $secret = $definition.settings | Where-Object secret

    # What each platform accepts, by name.
    $script:Allowed = @{
        GitHub  = @($definition.settings.name)
        Azure   = @($definition.settings.name | ForEach-Object { & $camel $_ })
        GitLab  = @($plain.name | ForEach-Object { $_ -replace '-', '_' }) + 'job_name', 'stage', 'image', 'runner_tags', 'actions_ref'
        Circle  = @($plain.name) + @($secret.name | ForEach-Object { "$_-variable" }) + 'actions-ref', 'executor', 'name', 'requires', 'context', 'filters', 'type'
        Jenkins = @($plain.name | ForEach-Object { & $camel $_ }) + @($secret.name | ForEach-Object { (& $camel $_) + 'CredentialsId' })
        Env     = @($definition.settings.env) + 'DSCPR_PLATFORM'
    }

    # The keys of the YAML mapping that starts on the line after $Index and is indented deeper
    # than $Indent. Only the mapping's own keys, not keys nested further down.
    function Get-MappingKey {
        param([string[]] $Line, [int] $Index, [int] $Indent)
        $keys = [System.Collections.Generic.List[string]]::new()
        $own = -1
        for ($i = $Index + 1; $i -lt $Line.Count; $i++) {
            if ($Line[$i] -match '^\s*(#.*)?$') { continue }
            $depth = ($Line[$i] -replace '^(\s*).*$', '$1').Length
            if ($depth -le $Indent) { break }
            if ($own -lt 0) { $own = $depth }
            if ($depth -eq $own -and $Line[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_-]*):') { $keys.Add($Matches[1]) }
        }
        return $keys
    }

    # Every use of an integration in a file, as { Platform; Keys; LineNumber }.
    function Get-IntegrationUse {
        param([string] $Path)
        $lines = @(Get-Content -LiteralPath $Path)
        for ($i = 0; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            $indent = ($line -replace '^(\s*).*$', '$1').Length

            if ($line -match 'uses:\s*ZanattaMichael/Dsc\.PipelineRunnerActions@' -or $line -match '^\s*(-\s*)?uses:\s*\./\s*$') {
                # 'with:' is a sibling of 'uses:'; '- uses:' puts the key two columns in.
                $keyIndent = if ($line -match '^\s*-\s') { $indent + 2 } else { $indent }
                for ($j = $i + 1; $j -lt $lines.Count -and $j -le $i + 3; $j++) {
                    if ($lines[$j] -match '^\s*with:\s*$' -and (($lines[$j] -replace '^(\s*).*$', '$1').Length -eq $keyIndent)) {
                        [pscustomobject]@{ Platform = 'GitHub'; Keys = Get-MappingKey $lines $j $keyIndent; LineNumber = $i + 1 }
                        break
                    }
                }
            }
            elseif ($line -match '^\s*-\s*task:\s*DscPipelineRunner@') {
                for ($j = $i + 1; $j -lt $lines.Count -and $j -le $i + 4; $j++) {
                    if ($lines[$j] -match '^\s*inputs:\s*$') { [pscustomobject]@{ Platform = 'Azure'; Keys = Get-MappingKey $lines $j (($lines[$j] -replace '^(\s*).*$', '$1').Length); LineNumber = $i + 1 }; break }
                }
            }
            elseif ($line -match '^\s*-\s*component:\s*.*dsc-pipeline-runner@') {
                for ($j = $i + 1; $j -lt $lines.Count -and $j -le $i + 2; $j++) {
                    if ($lines[$j] -match '^\s*inputs:\s*$') { [pscustomobject]@{ Platform = 'GitLab'; Keys = Get-MappingKey $lines $j (($lines[$j] -replace '^(\s*).*$', '$1').Length); LineNumber = $i + 1 }; break }
                }
            }
            elseif ($line -match '^\s*-\s*(dsc|dsc-pipeline-runner)/run:\s*$') {
                [pscustomobject]@{ Platform = 'Circle'; Keys = Get-MappingKey $lines $i ($indent + 2); LineNumber = $i + 1 }
            }
            elseif ($line -match 'dscPipelineRunner\(') {
                $call = ($lines[$i..([Math]::Min($i + 30, $lines.Count - 1))] -join "`n")
                $call = $call.Substring($call.IndexOf('dscPipelineRunner(') + 'dscPipelineRunner('.Length)
                $end = $call.IndexOf(')')
                if ($end -ge 0) { $call = $call.Substring(0, $end) }
                # A value can contain a colon (a URL); only names at the start of an argument count.
                $names = [regex]::Matches($call, '(?:^|,)\s*(?://[^\n]*\n\s*)*([A-Za-z][A-Za-z0-9]*)\s*:') | ForEach-Object { $_.Groups[1].Value }
                [pscustomobject]@{ Platform = 'Jenkins'; Keys = @($names); LineNumber = $i + 1 }
            }
        }
    }
}

Describe 'Example pipelines' {

    It 'There is an example for every platform' {
        foreach ($folder in 'github-actions', 'azure-devops', 'gitlab', 'circleci', 'jenkins', 'other') {
            @(Get-ChildItem -Path (Join-Path $Root "examples/$folder") -File -Force).Count | Should -BeGreaterThan 0
        }
    }

    It '<Name> uses an integration, and only with settings that exist' -ForEach $ExampleFiles {
        if ($Name -like 'examples/other/*') { Set-ItResult -Skipped -Because 'the generic examples are checked by their environment variables'; return }
        $uses = @(Get-IntegrationUse -Path $Path)
        $uses.Count | Should -BeGreaterThan 0 -Because 'an example that uses no integration is not an example'
        foreach ($use in $uses) {
            $use.Keys.Count | Should -BeGreaterThan 0 -Because "the use on line $($use.LineNumber) sets nothing"
            foreach ($key in $use.Keys) { $Allowed[$use.Platform] | Should -Contain $key -Because "line $($use.LineNumber) sets '$key', which is not a $($use.Platform) setting" }
        }
    }

    It '<Name> only sets DSCPR_* variables that exist' -ForEach $ExampleFiles {
        $names = [regex]::Matches((Get-Content -LiteralPath $Path -Raw), '\bDSCPR_[A-Z_]+\b') | ForEach-Object Value | Sort-Object -Unique
        foreach ($name in $names) { $Allowed.Env | Should -Contain $name }
    }

    It '<Name> never contains a literal secret or a token in a URL' -ForEach $ExampleFiles {
        $text = Get-Content -LiteralPath $Path -Raw
        $text | Should -Not -Match '://[^/\s:@]+:[^/\s@]+@'
        $text | Should -Not -Match '(?i)(source-token|sourceToken|azure-devops-token|azureDevopsToken)\s*[:=]\s*[''"]?[A-Za-z0-9]{20,}'
    }

    It '<Name> pins the module version wherever it runs the gallery module' -ForEach $ExampleFiles {
        if ($Name -like 'examples/other/run-anywhere.ps1') { $Path | Should -FileContentMatch 'DSCPR_MODULE_VERSION'; return }
        foreach ($use in @(Get-IntegrationUse -Path $Path)) {
            $pinned = $use.Keys | Where-Object { $_ -in 'module-version', 'moduleVersion', 'module_version', 'module-source', 'moduleSource', 'module_source' }
            $pinned | Should -Not -BeNullOrEmpty -Because "the use on line $($use.LineNumber) should show version pinning"
        }
    }
}

Describe 'Snippets in the documentation' {

    It '<Name> only shows settings that exist' -ForEach $DocFiles {
        foreach ($use in @(Get-IntegrationUse -Path $Path)) {
            foreach ($key in $use.Keys) { $Allowed[$use.Platform] | Should -Contain $key -Because "line $($use.LineNumber) shows '$key', which is not a $($use.Platform) setting" }
        }
    }

    It '<Name> only names DSCPR_* variables that exist' -ForEach $DocFiles {
        $names = [regex]::Matches((Get-Content -LiteralPath $Path -Raw), '\bDSCPR_[A-Z]+(?:_[A-Z]+)*\b') | ForEach-Object Value | Sort-Object -Unique |
            Where-Object { $_ -notin 'DSCPR_STATUS', 'DSCPR_FAIL_COUNT', 'DSCPR_PASS_COUNT', 'DSCPR_SKIP_COUNT', 'DSCPR_TOTAL_RESOURCES', 'DSCPR_REPORT_PATH', 'DSCPR_MODULE_VERSION' }
        foreach ($name in $names) { $Allowed.Env | Should -Contain $name }
    }

    It '<Name> has no relative link to a file that does not exist' -ForEach $DocFiles {
        $folder = Split-Path -Parent $Path
        $links = [regex]::Matches((Get-Content -LiteralPath $Path -Raw), '\]\((?!https?://|#|mailto:)([^)#\s]+)(#[^)]*)?\)|(?:src|srcset)="(?!https?://)([^"]+)"') |
            ForEach-Object { if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[3].Value } }
        foreach ($link in $links) { Test-Path -LiteralPath (Join-Path $folder $link) | Should -BeTrue -Because "$Name links to '$link'" }
    }
}

Describe 'The shell-agnostic command in the GitLab component and the CircleCI orb' {

    BeforeAll {
        $script:GitLabCommand = ((Get-Content -LiteralPath (Join-Path $Root 'templates/dsc-pipeline-runner.yml')) | Where-Object { $_ -match '^\s*-\s*pwsh ' }) -replace '^\s*-\s*', ''
        $script:OrbCommand = ((Get-Content -LiteralPath (Join-Path $Root 'circleci/orb.yml')) | Where-Object { $_ -match '^\s*command:\s*pwsh ' }) -replace '^\s*command:\s*', ''
    }

    It 'Is one command on each platform' {
        @($GitLabCommand).Count | Should -Be 1
        @($OrbCommand).Count | Should -Be 1
    }

    It 'Uses only single quotes around the script and none inside it, so sh, bash and PowerShell all read it the same way' {
        foreach ($command in $GitLabCommand, $OrbCommand) {
            $command | Should -Not -Match '"'
            ([regex]::Matches($command, "'")).Count | Should -Be 2
            $command | Should -Match "^pwsh -NoLogo -NoProfile -NonInteractive -Command '.+'$"
        }
    }

    It 'Fetches and runs the step the same way on both' {
        $fetchAndRun = $GitLabCommand.Substring($GitLabCommand.IndexOf('New-Item'))
        $OrbCommand | Should -BeLike "*$([System.Management.Automation.WildcardPattern]::Escape($fetchAndRun))"
    }

    It 'Is valid PowerShell that reads everything from the environment' {
        foreach ($command in $GitLabCommand, $OrbCommand) {
            $script = $command.Substring($command.IndexOf("'") + 1).TrimEnd("'")
            $errors = $null
            $null = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$errors)
            $errors | Should -BeNullOrEmpty
            $script | Should -Match 'exit \$LASTEXITCODE$'
        }
    }
}
