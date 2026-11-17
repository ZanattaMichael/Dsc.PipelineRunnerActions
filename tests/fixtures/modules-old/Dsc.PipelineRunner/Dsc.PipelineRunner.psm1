# Test stand-in for an older Dsc.PipelineRunner (see the manifest): no DryRun in -Mode.
function Invoke-DscRunner {
    [CmdletBinding()]
    param(
        [string] $Source = 'Local',
        [hashtable] $SourceContext = @{},
        [string] $ConfigurationSourcePath,
        [string] $ConfigurationRevision,
        [string] $Connect = 'None',
        [hashtable] $ConnectContext = @{},
        [ValidateSet('Test', 'Set')] [string] $Mode = 'Test',
        [string] $ReportPath,
        [string] $Engine = 'DscV2',
        [string] $EngineVersion,
        [switch] $FailOnError,
        [switch] $KeepTemporaryDirectory
    )

    @{ Mode = $Mode; ModuleVersion = [string]$MyInvocation.MyCommand.Module.Version } | ConvertTo-Json | Set-Content -LiteralPath $env:DSCPR_TEST_CALL_FILE
    [pscustomobject]@{ Status = 'Completed'; TotalResources = 1; PassCount = 1; FailCount = 0; SkipCount = 0 }
}
