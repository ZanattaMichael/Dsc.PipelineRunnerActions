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
        [switch] $KeepTemporaryDirectory
    )

    $recorded = @{}
    foreach ($key in $PSBoundParameters.Keys) { $recorded[$key] = $PSBoundParameters[$key] }
    if ($recorded.SourceContext -and $recorded.SourceContext.Token -is [securestring]) {
        $recorded.SourceContext = @{ Url = $recorded.SourceContext.Url; TokenIsSecureString = $true }
    }
    $recorded | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:DSCPR_TEST_CALL_FILE

    if ($env:DSCPR_TEST_THROW) { throw $env:DSCPR_TEST_THROW }

    $status = if ($env:DSCPR_TEST_STATUS) { $env:DSCPR_TEST_STATUS } else { 'Completed' }
    $fail = if ($status -eq 'Failed') { 1 } else { 0 }
    Write-Output 'noise that is not the summary'
    [pscustomobject]@{ Status = $status; TotalResources = 3; PassCount = 3 - $fail; FailCount = $fail; SkipCount = 0 }
}
