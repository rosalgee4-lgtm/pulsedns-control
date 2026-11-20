import { getDb } from '@/db';
import { type AliDnsCredentials, domainCredentials } from '@/lib/aliyun-accounts';
import { signAliyunRpcRequest } from '@/lib/aliyun-signature';

type DnsType = 'A' | 'AAAA';
type AliDnsResponse = {
  Code?: string;
  Message?: string;
  RequestId?: string;
  DomainRecords?: {
    Record?: Array<{
      RecordId: string;
      RR: string;
      Type: string;
      Value: string;
      Line?: string;
      Status?: string;
    }>;
  };
};

const HOST = 'alidns.aliyuncs.com';
const VERSION = '2015-01-09';

// enable：记录在阿里云上处于暂停状态时一并恢复解析（重新分配共享解析时使用）。
export async function syncAliDnsRecord(domainName: string, rr: string, type: DnsType, value: string, options: { enable?: boolean } = {}) {
  // 按主域名绑定的阿里云账号取 Key。
  let credentials: AliDnsCredentials;
  try {
    credentials = await domainCredentials(await getDb(), domainName);
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : '读取阿里云账号失败').slice(0, 180) } as const;
  }

  try {
    const listed = await callAliDns(credentials, 'DescribeDomainRecords', {
      DomainName: domainName,
      RRKeyWord: rr,
      TypeKeyWord: type,
      SearchMode: 'COMBINATION',
      Line: 'default',
      PageNumber: '1',
      PageSize: '500',
    });
    const matching = (listed.DomainRecords?.Record ?? []).filter((record) =>
      record.RR.toLowerCase() === rr.toLowerCase()
      && record.Type.toUpperCase() === type
      && (!record.Line || record.Line === 'default'),
    );

    if (matching.length > 1) {
      return { ok: false, error: `发现多条 ${rr} ${type} 默认线路记录，请先在阿里云控制台去重` } as const;
    }

    if (!matching.length) {
      await callAliDns(credentials, 'AddDomainRecord', {
        DomainName: domainName,
        RR: rr,
        Type: type,
        Value: value,
        TTL: '600',
        Line: 'default',
      });
      return { ok: true, created: true } as const;
    }

    const current = matching[0];
    const paused = (current.Status ?? '').toUpperCase() === 'DISABLE';
    if (options.enable && paused) {
      await callAliDns(credentials, 'SetDomainRecordStatus', { RecordId: current.RecordId, Status: 'Enable' });
    }
    if (current.Value === value) return options.enable && paused ? { ok: true, updated: true } as const : { ok: true, unchanged: true } as const;

    await callAliDns(credentials, 'UpdateDomainRecord', {
      RecordId: current.RecordId,
      RR: rr,
      Type: type,
      Value: value,
      TTL: '600',
      Line: 'default',
    });
    return { ok: true, updated: true } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : '阿里云 DNS 请求失败';
    return { ok: false, error: message.slice(0, 180) } as const;
  }
}

// 在阿里云上暂停一条解析（不删除）。记录不存在时视为成功。
export async function pauseAliDnsRecord(domainName: string, rr: string, type: DnsType) {
  try {
    const credentials = await domainCredentials(await getDb(), domainName);
    const listed = await callAliDns(credentials, 'DescribeDomainRecords', {
      DomainName: domainName,
      RRKeyWord: rr,
      TypeKeyWord: type,
      SearchMode: 'COMBINATION',
      PageNumber: '1',
      PageSize: '500',
    });
    const matching = (listed.DomainRecords?.Record ?? []).filter((record) =>
      record.RR.toLowerCase() === rr.toLowerCase() && record.Type.toUpperCase() === type);
    let paused = 0;
    for (const record of matching) {
      if ((record.Status ?? '').toUpperCase() === 'DISABLE') continue;
      await callAliDns(credentials, 'SetDomainRecordStatus', { RecordId: record.RecordId, Status: 'Disable' });
      paused += 1;
    }
    return { ok: true, paused } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : '阿里云 DNS 请求失败';
    return { ok: false, error: message.slice(0, 180) } as const;
  }
}

async function callAliDns(credentials: AliDnsCredentials, action: string, parameters: Record<string, string>) {
  const { accessKeyId, accessKeySecret } = credentials;

  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomUUID();
  const signed = await signAliyunRpcRequest({
    accessKeyId,
    accessKeySecret,
    action,
    version: VERSION,
    host: HOST,
    date,
    nonce,
    parameters,
  });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: signed.authorization,
    'x-acs-action': action,
    'x-acs-content-sha256': signed.bodyHash,
    'x-acs-date': date,
    'x-acs-signature-nonce': nonce,
    'x-acs-version': VERSION,
  };

  const response = await fetch(`https://${HOST}/?${signed.canonicalQuery}`, {
    method: 'POST',
    headers,
    body: '',
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => null) as AliDnsResponse | null;
  if (!response.ok || !result || result.Code) {
    const detail = [result?.Code, result?.Message].filter(Boolean).join(': ');
    throw new Error(detail || `阿里云 DNS 返回 HTTP ${response.status}`);
  }
  return result;
}

// 保存账号时检查 Key 是否真实有效：签名或 Key 错误会被拒绝；Key 有效但 RAM 权限
// 只限定到部分域名时，列出域名可能被拒，这种情况仍视为 Key 有效。
export async function verifyAliyunKey(credentials: AliDnsCredentials) {
  try {
    await callAliDns(credentials, 'DescribeDomains', { PageNumber: '1', PageSize: '1' });
    return { ok: true } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : '阿里云请求失败';
    if (/^(Forbidden|NoPermission)/.test(message)) return { ok: true } as const;
    return { ok: false, error: `阿里云 Key 校验失败：${message.slice(0, 160)}` } as const;
  }
}

// 保存主域名时检查这个 Key 能否读取该域名的解析记录（与自动同步使用同一接口）。
export async function verifyAliDnsDomain(credentials: AliDnsCredentials, domainName: string) {
  try {
    await callAliDns(credentials, 'DescribeDomainRecords', { DomainName: domainName, PageNumber: '1', PageSize: '1' });
    return { ok: true } as const;
  } catch (error) {
    const message = error instanceof Error ? error.message : '阿里云请求失败';
    return { ok: false, error: `该阿里云账号无法管理 ${domainName}：${message.slice(0, 160)}` } as const;
  }
}
