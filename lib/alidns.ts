import { env } from 'cloudflare:workers';
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
    }>;
  };
};

const HOST = 'alidns.aliyuncs.com';
const VERSION = '2015-01-09';

export async function syncAliDnsRecord(domainName: string, rr: string, type: DnsType, value: string) {
  if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET) {
    return { ok: false, skipped: true, error: '未配置阿里云 AccessKey' } as const;
  }

  try {
    const listed = await callAliDns('DescribeDomainRecords', {
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
      await callAliDns('AddDomainRecord', {
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
    if (current.Value === value) return { ok: true, unchanged: true } as const;

    await callAliDns('UpdateDomainRecord', {
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

async function callAliDns(action: string, parameters: Record<string, string>) {
  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) throw new Error('未配置阿里云 AccessKey');

  const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomUUID();
  const securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN;
  const signed = await signAliyunRpcRequest({
    accessKeyId,
    accessKeySecret,
    action,
    version: VERSION,
    host: HOST,
    date,
    nonce,
    parameters,
    securityToken,
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
  if (securityToken) headers['x-acs-security-token'] = securityToken;

  const response = await fetch(`https://${HOST}/?${signed.canonicalQuery}`, {
    method: 'POST',
    headers,
    body: '',
  });
  const result = await response.json().catch(() => null) as AliDnsResponse | null;
  if (!response.ok || !result || result.Code) {
    const detail = [result?.Code, result?.Message].filter(Boolean).join(': ');
    throw new Error(detail || `阿里云 DNS 返回 HTTP ${response.status}`);
  }
  return result;
}
