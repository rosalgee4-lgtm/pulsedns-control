export function buildNodeStartupLauncher(nodeId: string, installUrl: string) {
  const scriptPath = `/root/pulsedns_${nodeId}_install.sh`;
  return `#!/bin/bash\numask 077\nwget -O ${quoteShellArg(scriptPath)} ${quoteShellArg(installUrl)} && chmod +x ${quoteShellArg(scriptPath)} && bash ${quoteShellArg(scriptPath)}`;
}

function quoteShellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
