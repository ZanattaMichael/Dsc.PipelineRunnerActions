# Test stand-in for Dsc.PipelineRunner (see the manifest). Same parameters as the real
# Invoke-DscRunner that the step script uses.
function Invoke-DscRunner {
    [CmdletBinding()]
    param(
        [string] $Source = 'Local',
        [hashtable] $SourceContext = @{},
        [string] $ConfigurationSourcePath,
        [string] $ConfigurationRevision,
        [string] $Connect = 'None',
        [hashtable] $ConnectContext = @{},
        [ValidateSet('Test', 'Set', 'DryRun')] [string] $Mode = 'Test',
        [string] $ReportPath,
        [string] $Engine = 'DscV2',
        [string] $EngineVersion,
        [switch] $FailOnError,
        [switch] $KeepTemporaryDirectory,
        [string] $PolicyPath,
        [switch] $RequirePolicy
    )

    $recorded = @{}
    foreach ($key in $PSBoundParameters.Keys) {
        $value = $PSBoundParameters[$key]
        # A switch is recorded as a plain boolean, so a test can compare it.
        $recorded[$key] = if ($value -is [switch]) { [bool]$value } else { $value }
    }
    if ($recorded.SourceContext -and $recorded.SourceContext.Token -is [securestring]) {
        $recorded.SourceContext = @{ Url = $recorded.SourceContext.Url; TokenIsSecureString = $true }
    }
    # What the step set up around the call, for the tests that check it.
    $recorded.GlobalErrorActionPreference = [string]$global:ErrorActionPreference
    $recorded.ModuleVersion = [string]$MyInvocation.MyCommand.Module.Version
    $recorded | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:DSCPR_TEST_CALL_FILE

    if ($env:DSCPR_TEST_THROW) { throw $env:DSCPR_TEST_THROW }

    $status = if ($env:DSCPR_TEST_STATUS) { $env:DSCPR_TEST_STATUS } else { 'Completed' }
    $fail = if ($status -eq 'Failed') { 1 } else { 0 }
    if ($env:DSCPR_TEST_NO_SUMMARY) { return 'only noise' }
    Write-Output 'noise that is not the summary'
    [pscustomobject]@{ Status = $status; TotalResources = 3; PassCount = 3 - $fail; FailCount = $fail; SkipCount = 0 }
}
