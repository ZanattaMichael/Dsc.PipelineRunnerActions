# Requirements

The step checks these at the start of every run, prints the result as a table, and stops with the
complete list of what is missing. Nothing is installed or changed before the checks pass.

## Always

| Requirement | How to meet it |
| --- | --- |
| **PowerShell 7.0 or later** (`pwsh` on `PATH`) | Present on GitHub-hosted runners and Microsoft-hosted Azure DevOps agents. On your own agents install it from <https://aka.ms/powershell>. For containers use an image that has it; the GitLab and CircleCI integrations default to `mcr.microsoft.com/dotnet/sdk:8.0`. Windows PowerShell 5.1 is not enough. |
| **A configuration source** | Either `configuration-path` (check the repository out before the step) or `configuration-repository-url` (the step clones it; needs `git`). Exactly one. |
| **A writable report directory** | `report-path`, created if missing. |

## Installing modules

Unless `skip-module-install` is `true`, the step installs `Dsc.PipelineRunner` and the modules in
`resource-modules` for the current user.

| Requirement | How to meet it |
| --- | --- |
| Outbound HTTPS to `www.powershellgallery.com` and its CDN | Allow it on the agent's network, or |
| An internal feed | Register the repository on the agent and set `module-repository` to its name, or |
| No network at all | Bake the modules into the agent or image and set `skip-module-install: true`. |

Pin versions: `module-version: 1.2.1` and `resource-modules: Name@Version`. The step warns when a
version is not pinned, because an unpinned run can change behaviour without any change on your side.

The GitLab and CircleCI integrations also fetch the step script from
`raw.githubusercontent.com` at the start of the job (a component and an orb cannot carry files).

## Running the module from its source repository

By default the step installs a published release of Dsc.PipelineRunner. Set
`module-source: Repository` to build and run the module from its source repository instead: an
unreleased commit, a branch you are testing, or your own fork.

```yaml
module-source: Repository
module-source-ref: fe1560dfeca6f2692a2acdebb7eb4ea14e9ba484   # tag, branch or (recommended) full commit SHA
# module-source-repository: https://github.com/<you>/Dsc.PipelineRunner   # default: the upstream repository
```

| Requirement | Why |
| --- | --- |
| `git` on the agent | To clone the source repository. |
| Access to the PowerShell Gallery | The build restores its build tools, and the module's run-time dependencies are installed. `skip-module-install` cannot be combined with this. |
| A minute or two of extra run time | The module is built on every run. |
| A repository you trust | Its build script runs on the agent with the job's identity. |

What happens: the repository is cloned to a temporary directory and checked out at
`module-source-ref` (a full commit SHA is verified), `build.ps1 -ResolveDependency -Tasks build`
runs in a separate process, the run-time dependencies are installed (with the repository's own
pinned installer when the commit has one), and the built module (`output/Dsc.PipelineRunner/<version>/`) is imported by path. `module-version`
is ignored; the `module-version` output reports the version that was built.

For a private fork, give the agent access with a credential helper or an SSH key; a URL that
contains a token is rejected.

## By engine

| Engine | Requirement |
| --- | --- |
| `DscV2` | A Windows agent, in every mode including `DryRun`. On Linux and macOS DSC v2 needs the OMI library (`libmi`), which PowerShell does not include, and most DSC v2 resources are Windows-only. `PSDesiredStateConfiguration` 2.x is installed with the module. |
| `DscV3` | The `dsc` command-line engine must be on `PATH`. Not needed for `DryRun`. |

### DSC v3 engine

`dsc` is not installed by the step. Install it in an earlier step, or use an image that contains
it. Dsc.PipelineRunner ships a bootstrap script that downloads a release and verifies its SHA-256
before extracting it:

```powershell
# from a checkout of ZanattaMichael/Dsc.PipelineRunner at the tag you use
./scripts/Install-DscV3.ps1
```

See [Getting started on a hosted Linux agent with DSC v3](https://github.com/ZanattaMichael/Dsc.PipelineRunner/blob/main/docs/hosted-agent-dsc-v3.md).

## By mode

| Mode | Requirement |
| --- | --- |
| `DryRun` | Nothing beyond the configuration: no engine, no credentials, no connection. Safe for pull requests. Needs a Dsc.PipelineRunner release newer than 1.2.1; the step says so if the installed version does not support it. Until that release exists, use `module-source: Repository` (above). |
| `Test` | Read access to the systems the configuration describes. Changes nothing. |
| `Set` | Rights to change those systems, for the identity the agent runs as. Gate it with your platform's approvals (GitHub environments, Azure DevOps environment checks, GitLab protected environments, a CircleCI approval job, a Jenkins `input` step). |

## Secrets

| Secret | Needed when | Minimum access |
| --- | --- | --- |
| `source-token` | `configuration-repository-url` is a private repository cloned over HTTPS | Read access to that one repository |
| `azure-devops-token` | `connect: AzureDevOps` with `azure-devops-authentication: PAT`, in `Test` or `Set` mode | The Azure DevOps scopes your configuration manages, nothing more |

Where each platform keeps them:

| Platform | Store | How it reaches the step |
| --- | --- | --- |
| GitHub Actions | Repository, environment or organization secret | `source-token: ${{ secrets.NAME }}` |
| Azure DevOps | Secret pipeline variable or variable group | `sourceToken: $(Name)` (secret variables are not passed to tasks automatically) |
| GitLab | Masked (and protected) CI/CD variable | Named `DSCPR_SOURCE_TOKEN` / `DSCPR_AZURE_DEVOPS_TOKEN`; no input |
| CircleCI | Context or project environment variable | Named `DSCPR_SOURCE_TOKEN` / `DSCPR_AZURE_DEVOPS_TOKEN`, or another name given in `source-token-variable` |
| Jenkins | Credentials, kind "Secret text" | `sourceTokenCredentialsId: 'id'` |

Never put a token in the repository URL; the step rejects a URL that contains one.

## Azure DevOps connection

For a configuration that manages Azure DevOps itself (`connect: AzureDevOps`):

- `azure-devops-organization` is required.
- `AzureDevOpsDscNative` must be installed: add it to `resource-modules`.
- `azure-devops-authentication: PAT` needs `azure-devops-token`; `ManagedIdentity` needs an agent
  running with an Azure managed identity that has access to the organization.

## What the log shows

```
== Dsc.PipelineRunner: requirements
Requirement                       Status   Detail
--------------------------------  -------  ------------------------------------
PowerShell 7.0 or later           OK       PowerShell 7.4.6 on Ubuntu 24.04
Configuration directory exists    OK       /work/config
dsc command-line engine (DSC v3)  MISSING  not found on PATH
Report directory is writable      OK       /work/dsc-reports

== Dsc.PipelineRunner: settings
Setting             Value          Origin
------------------  -------------  -------
configuration-path  config         set
source-token        (not set)      default
mode                Test           default
...

1 problem(s) must be fixed before Dsc.PipelineRunner can run:
ERROR: 'engine' is DscV3 but the dsc command-line engine is not on PATH. ...
```

Exit codes: `0` success, `1` the run failed or could not run, `2` the settings are not valid.
