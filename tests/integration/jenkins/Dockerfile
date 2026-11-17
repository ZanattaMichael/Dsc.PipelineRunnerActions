# A Jenkins controller for the integration tests: the Pipeline plugins, configuration as code,
# and PowerShell 7, which the dscPipelineRunner step needs on the agent that runs it (here the
# controller's own built-in node).
FROM jenkins/jenkins:lts-jdk17

USER root

# PowerShell 7, from the release archive. It is linked into /usr/local/bin only, so a test can
# hide it by running with PATH=/usr/bin:/bin.
ARG POWERSHELL_VERSION=7.4.6
RUN apt-get update \
 && apt-get install -y --no-install-recommends libicu-dev ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL "https://github.com/PowerShell/PowerShell/releases/download/v${POWERSHELL_VERSION}/powershell-${POWERSHELL_VERSION}-linux-x64.tar.gz" \
    | tar -xz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
 # The library and the fixtures are mounted from the host and owned by another user.
 && git config --system --add safe.directory '*'

USER jenkins

RUN jenkins-plugin-cli --plugins \
    workflow-aggregator \
    pipeline-groovy-lib \
    git \
    credentials-binding \
    plain-credentials \
    configuration-as-code

COPY jenkins.yaml /usr/share/jenkins/ref/jenkins.yaml

ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/ref/jenkins.yaml
# No setup wizard; and allow the shared library to be read from a local git repository
# (the git plugin refuses local paths on the controller unless told otherwise).
ENV JAVA_OPTS="-Djenkins.install.runSetupWizard=false -Dhudson.plugins.git.GitSCM.ALLOW_LOCAL_CHECKOUT=true"
