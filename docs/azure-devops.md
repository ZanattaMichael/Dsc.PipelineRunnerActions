# <img src="../assets/logo-azure-devops.svg" alt="" width="48" align="top"> Azure DevOps

The integration is a pipeline task, `DscPipelineRunner@1`, delivered in the **Dsc.PipelineRunner**
extension.

## Requirements

- The extension installed in the organization (Organization settings > Extensions, or from the
  Visual Studio Marketplace). Installing needs the Project Collection Administrator role, or a
  request an administrator approves.
- Agent version 3.232.1 or later with PowerShell 7 on `PATH`. Microsoft-hosted agents qualify. The
  task runs on Windows, Linux and macOS agents and in deployment groups.
- Everything in [requirements.md](requirements.md) that applies to your engine and mode.

## Use

```yaml
steps:
  - checkout: self
  - task: DscPipelineRunner@1
    name: dsc
    inputs:
      configurationPath: config
      mode: Test
      moduleVersion: 1.2.1
      resourceModules: |
        PSDscResources@2.12.0.0
  - publish: $(dsc.report_path)
    artifact: dsc-reports
    condition: always()
```

In the classic editor and the YAML task assistant the inputs are grouped (Configuration source,
Run, Azure DevOps connection, Installation, Diagnostics) and each has help text. Inputs that only
apply to another choice are hidden, for example the token inputs.

Input names are the camelCase form of the settings in [settings.md](settings.md).

## Secrets

Secret variables are not handed to tasks automatically. Pass them as inputs:

```yaml
    inputs:
      configurationRepositoryUrl: https://dev.azure.com/contoso/Platform/_git/config
      sourceToken: $(ConfigRepoToken)
```

If the variable is not defined, Azure DevOps leaves the text `$(ConfigRepoToken)` in place. The
task detects that and fails with the name of the missing variable, instead of using the text as a
token.

To clone a repository in the same organization with the job's own identity, pass
`sourceToken: $(System.AccessToken)` and give the build service read access to that repository.

## Outputs

Give the task a `name:` and read `$(dsc.status)`, `$(dsc.total_resources)`, `$(dsc.pass_count)`,
`$(dsc.fail_count)`, `$(dsc.skip_count)`, `$(dsc.report_path)`, `$(dsc.module_version)`. From another
job use `dependencies.<job>.outputs['dsc.status']`.

Errors and warnings appear as pipeline issues on the run summary.

## Gate a `Set`

Use a deployment job that targets an environment with approvals and checks. See
[`examples/azure-devops`](../examples/azure-devops).

## Managing Azure DevOps itself

Set `connect: AzureDevOps`, `azureDevopsOrganization`, and either a PAT in `azureDevopsToken` or
`azureDevopsAuthentication: ManagedIdentity`, and list `AzureDevOpsDscNative` in `resourceModules`.
