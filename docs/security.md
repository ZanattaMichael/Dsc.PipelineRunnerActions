# Security

## How inputs are handled

- Every integration passes settings to the step as **environment variables**. No input is written
  into script text, so an input value cannot inject a command (the GitHub Action's `run:` block
  contains no `${{ }}` expression; a test enforces this).
- Fixed-value settings are checked against their allowed values, versions and module names against
  a strict pattern, before anything is installed or run.
- Text that comes back from a run is flattened to one line and defused before it is written to a
  log, so a message cannot issue a logging command (`::set-output`, `##vso[...]`).

## How secrets are handled

- Secrets come from the platform's secret store, never from plain settings. The GitLab component
  and the CircleCI orb have no secret inputs at all; the Jenkins step accepts only credential IDs.
- The settings table shows secrets as `(set, hidden)` or `(not set)`.
- A repository URL that contains a password or token is rejected.
- An Azure DevOps secret variable that is not defined (which arrives as the literal `$(Name)`) is
  rejected instead of being used as a token.
- The clone token is handed to Dsc.PipelineRunner as a `SecureString`; it is never on a command line.

## What to pin

| What | How |
| --- | --- |
| The integration | A release tag, or a full commit SHA (`uses: ...@<sha>`, `actions_ref`, the Jenkins library version). The CircleCI orb pins the step script to the release commit when it is published. |
| Dsc.PipelineRunner | `module-version` |
| Resource modules | `Name@Version` in `resource-modules` |
| The configuration | `configuration-revision` with a full commit SHA (verified after the clone) |

The step warns for each of these that is not pinned.

## Least privilege

- `Test` and `DryRun` jobs need no write access anywhere. Give `Set` jobs their rights through a
  protected environment with approvals.
- `source-token`: read access to the configuration repository only.
- Publishing tokens (see [publishing.md](publishing.md)) are used only by the release pipeline and
  are never available to pull-request builds.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository, or the process in
[Dsc.PipelineRunner's security policy](https://github.com/ZanattaMichael/Dsc.PipelineRunner/blob/main/SECURITY.md).
