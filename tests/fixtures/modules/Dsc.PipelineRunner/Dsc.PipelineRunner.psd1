@{
    RootModule        = 'Dsc.PipelineRunner.psm1'
    ModuleVersion     = '9.9.9'
    GUID              = 'b0a7c1b4-2c64-4f0b-9d5e-6d5b0b0f7a11'
    Description       = 'Test stand-in for Dsc.PipelineRunner. Records the arguments it was called with and returns a summary chosen by the test.'
    FunctionsToExport = 'Invoke-DscRunner'
}
