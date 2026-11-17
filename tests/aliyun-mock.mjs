// 测试用：模拟阿里云 DNS 接口。每个 AccessKey ID 只能管理自己账号下的域名。
export function installAliyunMock(owned) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host !== 'alidns.aliyuncs.com') return realFetch(input, init);
    const keyId = /Credential=([^,]+),/.exec(init.headers.Authorization)[1];
    const action = init.headers['x-acs-action'];
    const domain = url.searchParams.get('DomainName');
    calls.push({ keyId, action, domain });
    const fail = (Code, status = 400) => Response.json({ Code, Message: Code }, { status });
    if (!owned[keyId]) return fail('InvalidAccessKeyId.NotFound', 404);
    if (action === 'DescribeDomains') return owned[keyId].scoped ? fail('Forbidden.RAM', 403) : Response.json({ Domains: { Domain: [] } });
    if (!owned[keyId].domains.includes(domain)) return fail('InvalidDomainName.NoExist');
    if (action === 'DescribeDomainRecords') return Response.json({ DomainRecords: { Record: [] } });
    return Response.json({ RecordId: '1' });
  };
  return calls;
}
