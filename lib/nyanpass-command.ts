export type ParsedNyanpassCommand =
  | { ok: true; args: string; clientToken: string; panelUrl: string; role: 'inbound' | 'outbound' }
  | { ok: false; error: string };

const officialInstallerUrl = 'https://dl.nyafw.com/download/nyanpass-install.sh';
const escapedInstallerUrl = escapeRegExp(officialInstallerUrl);
const officialCommandPattern = new RegExp(
  `^bash[ \\t]+<\\([ \\t]*curl[ \\t]+-fLSs[ \\t]+(?:${escapedInstallerUrl}|"${escapedInstallerUrl}"|'${escapedInstallerUrl}')[ \\t]*\\)[ \\t]+rel_nodeclient[ \\t]+(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)')[ \\t]*$`,
);

export function parseOfficialNyanpassCommand(value: unknown): ParsedNyanpassCommand {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    return { ok: false, error: '请粘贴完整的 Nyanpass 官方安装命令' };
  }

  const match = value.trim().match(officialCommandPattern);
  if (!match) {
    return { ok: false, error: '命令格式无效：必须使用官方安装脚本并调用 rel_nodeclient' };
  }

  return parseNyanpassArgs(match[1] ?? match[2] ?? '');
}

export function parseNyanpassArgs(value: unknown): ParsedNyanpassCommand {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\r\n]/.test(value)) {
    return { ok: false, error: 'rel_nodeclient 参数格式无效' };
  }
  const tokens = value.trim().split(/[ \t]+/).filter(Boolean);
  if (tokens.length < 4 || tokens.length > 64 || tokens.some((token) => !/^[A-Za-z0-9._~:/@%+=,-]{1,512}$/.test(token))) {
    return { ok: false, error: 'rel_nodeclient 包含不安全或过多的参数' };
  }
  let hasOutboundFlag = false;
  let token = '';
  let urlValue = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const argument = tokens[index];
    if (argument === '-o') {
      if (hasOutboundFlag) return { ok: false, error: '命令中的 -o 只能出现一次' };
      hasOutboundFlag = true;
      continue;
    }
    if (argument === '-t') {
      if (token) return { ok: false, error: '命令中的 -t 只能出现一次' };
      token = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument === '-u') {
      if (urlValue) return { ok: false, error: '命令中的 -u 只能出现一次' };
      urlValue = tokens[index + 1] ?? '';
      index += 1;
      continue;
    }
    continue;
  }

  if (!/^[A-Za-z0-9._~:+/=-]{8,512}$/.test(token)) {
    return { ok: false, error: '命令必须包含唯一且格式有效的 -t 节点令牌' };
  }

  const panelUrl = normalizeHttpsUrl(urlValue);
  if (!panelUrl) return { ok: false, error: '命令必须包含唯一且有效的 HTTPS -u 面板地址' };

  return {
    ok: true,
    args: tokens.join(' '),
    clientToken: token,
    panelUrl,
    role: hasOutboundFlag ? 'outbound' : 'inbound',
  };
}

function normalizeHttpsUrl(raw: string) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~:/@%+=,-]*)?$/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
