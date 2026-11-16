# Dsc.PipelineRunner

Run a Datum-driven Desired State Configuration from Azure Pipelines with
[Dsc.PipelineRunner](https://github.com/ZanattaMichael/Dsc.PipelineRunner): report drift, apply the
configuration, or validate it without touching anything.

```yaml
steps:
  - checkout: self
  - task: DscPipelineRunner@1
    name: dsc
    inputs:
      configurationPath: config        # the folder that contains Datum.yml
      mode: Test                       # Test reports drift, Set applies, DryRun validates
      moduleVersion: 1.2.1             # pin the Dsc.PipelineRunner version
      resourceModules: |
        PSDscResources@2.12.0.0
  - publish: $(dsc.report_path)
    artifact: dsc-reports
    condition: always()
```

## What you need

| Requirement | When |
| --- | --- |
| Agent 3.232.1 or later with PowerShell 7 (`pwsh`) | Always. Microsoft-hosted agents qualify. |
| Access to the PowerShell Gallery, or an internal feed | Unless `skipModuleInstall` is on |
| A Windows agent | DscV2 engine with Windows-only resources |
| The `dsc` command-line engine on `PATH` | DscV3 engine |
| A secret variable with a token | Private configuration repository, or `connect: AzureDevOps` with a PAT |

The task checks all of this first and reports everything that is missing in one pass. It then
prints the effective value of every input (secrets only as set or not set).

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `configurationPath` | | Folder in the workspace that contains `Datum.yml`. |
| `configurationRepositoryUrl`, `configurationRevision`, `sourceToken` | | Or: a Git repository to clone, the commit to use, and a token for it. |
| `mode` | `Test` | `Test`, `Set` or `DryRun`. |
| `engine`, `engineVersion` | `DscV2` | `DscV2` or `DscV3`. |
| `failOnError` | `true` | Fail the task when the run failed. In `Test` mode drift is a failure. |
| `reportPath` | `dsc-reports` | Where reports are written. |
| `connect`, `azureDevopsOrganization`, `azureDevopsAuthentication`, `azureDevopsToken` | `None` | Open an Azure DevOps session, for configurations that manage Azure DevOps. |
| `moduleVersion`, `allowPrerelease`, `moduleRepository`, `resourceModules`, `skipModuleInstall` | | What to install, and from where. |
| `keepTemporaryDirectory`, `verbose` | `false` | Diagnostics. |

Full reference: [settings](https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions/blob/main/docs/settings.md),
[requirements](https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions/blob/main/docs/requirements.md),
[Azure DevOps guide](https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions/blob/main/docs/azure-devops.md).

## Outputs

`status`, `total_resources`, `pass_count`, `fail_count`, `skip_count`, `report_path`,
`module_version`, read as `$(dsc.status)` when the task has `name: dsc`.

## Secrets

Pass a secret variable as an input: `sourceToken: $(ConfigRepoToken)`. If the variable is not
defined the task says so instead of using the text as a token.

## Support

[Issues](https://github.com/ZanattaMichael/Dsc.PipelineRunnerActions/issues) · MIT licence
