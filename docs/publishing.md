# Publishing

One manual pipeline releases everything: **Actions > Release > Run workflow**, on `main`, with a
version such as `1.2.0`.

```
Release (release.yml)
 ├─ tag            checks main's CI is green, creates v1.2.0, moves v1, creates the GitHub release
 ├─ azure-devops   publish-azure-devops.yml   → Visual Studio Marketplace
 ├─ gitlab         publish-gitlab.yml         → GitLab project → .gitlab-ci.yml → CI/CD Catalog
 └─ circleci       publish-circleci.yml       → CircleCI orb registry
```

Each publish pipeline can also be run on its own (Run workflow, with a version and a tag) to
retry one target. A target that is not configured is skipped with a notice; the release still
succeeds, and the built package (`.vsix`, pinned `orb.yml`) is attached to the run.

Every registry needs an account and a one-time setup that only you can do. This page lists them.

## Summary of what to configure

Repository **variables** and **secrets** (Settings > Secrets and variables > Actions):

| Target | Variables | Secrets |
| --- | --- | --- |
| GitHub Marketplace | none | none |
| Azure DevOps | `AZURE_DEVOPS_PUBLISHER`; optional `AZURE_DEVOPS_EXTENSION_PUBLIC`, `AZURE_DEVOPS_SHARE_WITH` | `AZURE_DEVOPS_MARKETPLACE_TOKEN` |
| GitLab | `GITLAB_PROJECT_URL` | `GITLAB_PUSH_TOKEN` |
| CircleCI | `CIRCLECI_NAMESPACE` | `CIRCLECI_TOKEN` |
| Jenkins | none | none |

## GitHub Marketplace

Requirements GitHub sets: a public repository, one `action.yml` at the root, an action `name` that
is unique on the Marketplace, two-factor authentication on the publishing account, and the
Marketplace Developer Agreement accepted.

One-time, and for each release you want listed:

1. Run the Release pipeline. It creates the tag and the GitHub release.
2. Open the release, choose **Edit**, tick **Publish this Action to the GitHub Marketplace**, pick
   the categories (first time), and save. GitHub only offers this in the web interface; it cannot
   be done by the pipeline.

If GitHub reports that the name `Dsc.PipelineRunner` is taken, change `name:` in `action.yml`.

Users reference `ZanattaMichael/Dsc.PipelineRunnerActions@v1`; the pipeline moves `v1` to each
1.x release.

## Azure DevOps (Visual Studio Marketplace)

One-time:

1. Create a publisher at <https://marketplace.visualstudio.com/manage>. Put its ID in the variable
   `AZURE_DEVOPS_PUBLISHER`.
2. Create an Azure DevOps personal access token with **Organization: All accessible
   organizations** and scope **Marketplace > Publish**. Store it as the secret
   `AZURE_DEVOPS_MARKETPLACE_TOKEN`. It expires; renew it before it does.
3. Decide on visibility:
   - Private (the default): set `AZURE_DEVOPS_SHARE_WITH` to the organizations that may install
     it, separated by spaces.
   - Public: set `AZURE_DEVOPS_EXTENSION_PUBLIC` to `true`. Microsoft must first verify the
     publisher for public listings.

Each release: the pipeline writes the version into `task.json` and `vss-extension.json`, copies
`core/` into the task, packages the `.vsix` with `tfx`, and publishes it. The extension ID is
`dsc-pipeline-runner`; the task is `DscPipelineRunner@<major>`.

Marketplace rules the pipeline already respects: the version must increase with every publish, the
task GUID never changes, and the listing page is `azure-devops/overview.md`.

## GitLab (CI/CD Catalog)

GitLab only reads components from a GitLab project, so the release is pushed to one.

One-time:

1. Create a project, for example `<group>/dsc-pipelinerunner-actions`, **without** initialising it
   (no README). Give it a description (the Catalog requires one).
2. Settings > General > Visibility, project features, permissions: turn on **CI/CD Catalog
   project**. This needs the Owner role.
3. Settings > Access tokens: create a project access token with role **Maintainer** and scope
   **write_repository**. Store it as the secret `GITLAB_PUSH_TOKEN`.
4. Put the project's HTTPS clone URL in the variable `GITLAB_PROJECT_URL`.
5. If `main` is protected against pushes by Maintainers, allow them, or allow the token's bot user.

Each release: the pipeline pushes the release commit to `main` and a tag `1.2.0` (the Catalog wants
a plain semantic version, so there is no leading `v` on GitLab). The GitLab project's pipeline
(`.gitlab-ci.yml`) runs the component against a stand-in module, then creates the release with the
`release` keyword, which is what publishes the version to the Catalog.

Users include `$CI_SERVER_FQDN/<group>/dsc-pipelinerunner-actions/dsc-pipeline-runner@1`.

On a self-managed GitLab the same steps apply; the project then also needs outbound access to
`raw.githubusercontent.com`, or set `actions_ref` and mirror `core/` where your runners can reach it.

## CircleCI (orb registry)

One-time, with the CircleCI CLI on your own machine:

1. Claim a namespace for your organization (one per organization):
   `circleci namespace create <namespace> --org-id <organization id>`
2. Create the orb: `circleci orb create <namespace>/dsc-pipeline-runner`
3. Create a personal API token (User settings > Personal API tokens) for a user who is an
   organization admin; store it as the secret `CIRCLECI_TOKEN`.
4. Put the namespace in the variable `CIRCLECI_NAMESPACE`.

Each release: the pipeline replaces the placeholder `__DSCPR_ACTIONS_REF__` in `circleci/orb.yml`
with the release commit, validates the orb and publishes
`<namespace>/dsc-pipeline-runner@1.2.0`. Published orb versions are immutable.

Users of an orb from a namespace that is not certified must enable **Allow uncertified orbs** in
their organization's security settings.

## Jenkins

Nothing is published. Jenkins loads the shared library from this repository at the version a
Jenkinsfile names (`@v1`, `@v1.2.0` or a commit), with Library Path `jenkins/`. The release tag is
the deployment. See [jenkins.md](jenkins.md).

## Logos

`assets/` holds one logo per integration, each in a light and a dark SVG and a 512 px PNG, plus the
README headers. They are generated by `tools/build-logos.js`; change the script, not the files.

| Logo | Where it is used | How it gets there |
| --- | --- | --- |
| `logo.svg` / `logo-512.png` | This repository; a good social preview image | README header is automatic; the social preview is set in the repository settings |
| `logo-github-actions` | Documentation | GitHub Marketplace does not take a custom image: the listing shows the `branding` icon and colour from `action.yml` |
| `logo-azure-devops` | The extension's icon on the Visual Studio Marketplace | Automatic: packaged as `azure-devops/images/extension-icon.png` |
| `logo-gitlab` | The component's project avatar in the CI/CD Catalog | Once, by hand: Settings > General > Project avatar, upload `assets/logo-gitlab-512.png` |
| `logo-circleci` | Documentation | The orb registry shows no image |
| `logo-jenkins` | Documentation | Shared libraries have no listing |
| `logo-generic` | Documentation for other platforms | |

The badges use plain shapes and each platform's customary colour. They are not the platforms' own
logos, so no trademark permission is involved.

## Versioning

- One version for everything: tag `v1.2.0`, GitHub release, extension and task version, GitLab
  tag `1.2.0`, orb version `1.2.0`.
- A breaking change (a removed setting, a changed default) is a new major version. The Azure
  DevOps task then becomes `DscPipelineRunner@2` and the moving tag `v2`.
- Releases are only cut from `main`, and only from a commit whose CI passed.
