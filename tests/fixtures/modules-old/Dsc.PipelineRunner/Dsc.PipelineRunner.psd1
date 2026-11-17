@{
    RootModule        = 'Dsc.PipelineRunner.psm1'
    ModuleVersion     = '1.0.0'
    GUID              = 'b0a7c1b4-2c64-4f0b-9d5e-6d5b0b0f7a11'
    Description       = 'Test stand-in for an older Dsc.PipelineRunner: its Invoke-DscRunner has no DryRun mode.'
    FunctionsToExport = 'Invoke-DscRunner'
}
