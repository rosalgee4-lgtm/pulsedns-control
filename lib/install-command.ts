export type ProvisionedNyanpassInstance = {
  name: string;
  optimize: boolean;
  args: string;
};

type NodeProvisionCommandInput = {
  origin: string;
  token: string;
  rootPassword: string;
  instances: ProvisionedNyanpassInstance[];
};

export function buildNodeProvisionCommand({ origin, token, rootPassword, instances }: NodeProvisionCommandInput) {
  const instanceArguments = instances
    .map((instance) => ` --nyanpass-instance ${shellArg(instance.name)} ${shellArg(instance.optimize ? '1' : '0')} ${shellArg(instance.args)}`)
    .join('');
  const installerUrl = `${origin.replace(/\/$/, '')}/install.sh`;

  return `( set -Eeuo pipefail; tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT; curl --proto '=http,https' --proto-redir '=http,https' --connect-timeout 10 --max-time 60 -fLSs ${shellArg(installerUrl)} -o "$tmp"; grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp"; bash -n "$tmp"; bash "$tmp" provision --server ${shellArg(origin)} --token ${shellArg(token)} --root-password ${shellArg(rootPassword)}${instanceArguments} )`;
}

export function shellArg(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
