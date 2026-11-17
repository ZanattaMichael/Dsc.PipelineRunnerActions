#requires -Version 7.0
<#
.SYNOPSIS
Runs the Jenkins integration tests: a real Jenkins controller in Docker loads the shared library
from this repository and runs pipelines that call the dscPipelineRunner step.

.DESCRIPTION
What is real: Jenkins, the Pipeline engine and its sandbox, the shared-library loader (a Git
repository with Library Path jenkins/, as docs/jenkins.md describes), credentials binding and log
masking, the sh step, PowerShell 7, and the step script.

What is a stand-in: Dsc.PipelineRunner itself (tests/fixtures/modules), which records the
arguments it was called with, so a case can check them and no DSC resources are needed.

Each case is a folder under cases/ with a Jenkinsfile and an expect.json:
  result       the build result the case must end with (SUCCESS or FAILURE)
  contains     regular expressions the console log must match
  notContains  regular expressions the console log must not match

Requires Docker. Takes a few minutes; most of it is building the image and starting Jenkins.

.PARAMETER Case
Run only the cases whose folder name matches this wildcard.

.PARAMETER KeepContainer
Leave the controller running afterwards (docker rm -f dscpr-jenkins-it to remove it).
#>
[CmdletBinding()]
param(
    [string] $Case = '*',
    [switch] $KeepContainer
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = (Resolve-Path (Join-Path $here '../../..')).Path
$image = 'dscpr-jenkins-it'
$container = 'dscpr-jenkins-it'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('dscpr-jenkins-' + [guid]::NewGuid().ToString('N'))

function Invoke-Native {
    param([string] $What, [scriptblock] $Command)
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)." }
}

function ConvertTo-XmlText { param([string] $Text) [System.Security.SecurityElement]::Escape($Text) }

try {
    # 1. The library as Jenkins will fetch it: a git repository holding the working tree as it is
    #    now (committed or not), on a branch called under-test.
    $library = Join-Path $work 'library'
    $null = New-Item -ItemType Directory -Path $library -Force
    Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin '.git', 'node_modules', 'dist', 'dsc-reports' } |
        Copy-Item -Destination $library -Recurse -Force
    Invoke-Native 'git init' { git -C $library init -q }
    Invoke-Native 'git checkout' { git -C $library checkout -q -b under-test }
    Invoke-Native 'git add' { git -C $library add -A }
    Invoke-Native 'git commit' { git -C $library -c user.name='Integration tests' -c user.email='integration@example.test' -c commit.gpgsign=false commit -q -m 'The library under test' }
    # The container's jenkins user is not this user.
    if (-not $IsWindows) { chmod -R a+rX $work }

    # 2. The controller.
    Write-Host '== Building the Jenkins image'
    Invoke-Native 'docker build' { docker build --quiet --tag $image $here }

    docker rm -f $container 2>$null | Out-Null
    Write-Host '== Starting Jenkins'
    Invoke-Native 'docker run' {
        docker run --detach --name $container `
            --volume "${library}:/library:ro" `
            --volume "${library}:/repo:ro" `
            $image | Out-Null
    }

    $deadline = (Get-Date).AddMinutes(6)
    while ($true) {
        docker exec $container curl --silent --fail --output /dev/null http://localhost:8080/login 2>$null
        if ($LASTEXITCODE -eq 0) { break }
        if ((docker inspect --format '{{.State.Running}}' $container 2>$null) -ne 'true') { throw 'The Jenkins container stopped while starting.' }
        if ((Get-Date) -gt $deadline) { throw 'Jenkins did not become ready within 6 minutes.' }
        Start-Sleep -Seconds 5
    }
    Invoke-Native 'fetching the Jenkins CLI' { docker exec $container curl --silent --fail --output /tmp/cli.jar http://localhost:8080/jnlpJars/jenkins-cli.jar }
    Write-Host '== Jenkins is ready'
    Invoke-Native 'the Jenkins CLI' { docker exec $container java -jar /tmp/cli.jar -s http://localhost:8080 version }
    # Fail early, and clearly, if configuration as code did not register the library under test.
    $libraries = docker exec $container curl --silent --fail 'http://localhost:8080/manage/configuration-as-code/export' --request POST 2>$null | Out-String
    if ($libraries -notmatch 'dsc-pipeline-runner') {
        Write-Host $libraries
        throw 'Configuration as code did not register the dsc-pipeline-runner library.'
    }

    # 3. The cases.
    $results = [System.Collections.Generic.List[object]]::new()
    $caseFolders = @(Get-ChildItem -LiteralPath (Join-Path $here 'cases') -Directory | Where-Object Name -Like $Case | Sort-Object Name)
    if ($caseFolders.Count -eq 0) { throw "No case matches '$Case'." }

    foreach ($folder in $caseFolders) {
        $name = $folder.Name
        $expect = Get-Content -LiteralPath (Join-Path $folder.FullName 'expect.json') -Raw | ConvertFrom-Json
        $script = Get-Content -LiteralPath (Join-Path $folder.FullName 'Jenkinsfile') -Raw

        # A Pipeline job whose script runs in the Groovy sandbox, as an ordinary user's would.
        $jobXml = @"
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition">
    <script>$(ConvertTo-XmlText $script)</script>
    <sandbox>true</sandbox>
  </definition>
</flow-definition>
"@
        $jobXml | docker exec --interactive $container java -jar /tmp/cli.jar -s http://localhost:8080 create-job $name
        if ($LASTEXITCODE -ne 0) { throw "Could not create the job for case '$name'." }

        # -s waits for the build; -v prints its console log. The exit code reflects the build
        # result, which for a case that expects FAILURE is not an error here.
        $console = (docker exec $container java -jar /tmp/cli.jar -s http://localhost:8080 build $name -s -v 2>&1 | Out-String)
        $build = docker exec $container curl --silent --fail "http://localhost:8080/job/$name/lastBuild/api/json?tree=result" | ConvertFrom-Json

        $problems = [System.Collections.Generic.List[string]]::new()
        if ($build.result -ne $expect.result) { $problems.Add("the build result is $($build.result), expected $($expect.result)") }
        foreach ($pattern in @($expect.contains)) { if ($pattern -and $console -notmatch $pattern) { $problems.Add("the log does not match: $pattern") } }
        if ($expect.PSObject.Properties['notContains']) {
            foreach ($pattern in @($expect.notContains)) { if ($pattern -and $console -match $pattern) { $problems.Add("the log must not match: $pattern") } }
        }

        $passed = $problems.Count -eq 0
        $results.Add([pscustomobject]@{ Case = $name; Result = $build.result; Passed = $passed; Problems = $problems })
        Write-Host ("{0} {1} ({2})" -f $(if ($passed) { '[+]' } else { '[-]' }), $name, $build.result)
        if (-not $passed) {
            foreach ($problem in $problems) { Write-Host "      $problem" }
            Write-Host "------ console log of $name"
            Write-Host $console
            Write-Host '------'
        }
    }

    $failed = @($results | Where-Object { -not $_.Passed })
    Write-Host ''
    Write-Host ("Jenkins integration tests: {0} passed, {1} failed." -f ($results.Count - $failed.Count), $failed.Count)
    if ($env:GITHUB_STEP_SUMMARY) {
        $lines = @('### Jenkins integration tests', '', '| Case | Build result | Outcome |', '| --- | --- | --- |') +
            ($results | ForEach-Object { '| {0} | {1} | {2} |' -f $_.Case, $_.Result, $(if ($_.Passed) { 'passed' } else { 'FAILED: ' + ($_.Problems -join '; ') }) })
        Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $lines
    }
    if ($failed.Count -gt 0) {
        Write-Host '------ Jenkins log (last 80 lines)'
        docker logs --tail 80 $container 2>&1 | Write-Host
        exit 1
    }
}
catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if (docker ps --all --quiet --filter "name=^$container$" 2>$null) {
        Write-Host '------ Jenkins log (last 120 lines)'
        docker logs --tail 120 $container 2>&1 | Write-Host
    }
    exit 1
}
finally {
    if (-not $KeepContainer) { docker rm -f $container 2>$null | Out-Null }
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
