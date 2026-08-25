'use client';

import { FormEvent, useEffect, useState } from 'react';
import { copyText } from '@/lib/copy-text';
import { filterEvents } from '@/lib/event-filter';

type ViewId = 'overview' | 'nodes' | 'records' | 'nyanpass' | 'activity';

const navigation: Array<{ id: ViewId; icon: string; label: string }> = [
  { id: 'overview', icon: '◫', label: '总览' },
  { id: 'nodes', icon: '⌁', label: '节点' },
  { id: 'records', icon: '◎', label: 'DNS 记录' },
  { id: 'nyanpass', icon: '⇄', label: '合租实例' },
  { id: 'activity', icon: '↻', label: '事件日志' },
];

const viewTitles: Record<ViewId, string> = {
  overview: '网络控制台',
  nodes: '探针节点',
  records: 'DNS 记录',
  nyanpass: 'Nyanpass 合租实例',
  activity: '事件日志',
};

function isViewId(value: string): value is ViewId {
  return navigation.some((item) => item.id === value);
}

type NodeRow = {
  id: string; name: string; region: string; ipv4: string | null; ipv6: string | null;
  recordV4: string | null; recordV6: string | null; lastSeenAt: string | null;
  createdAt: string; updatedAt: string;
  provider: string; domainName: string | null; syncEnabled: boolean; tokenHash: string;
};
type EventRow = { id: number; nodeId: string; nodeName: string; level: string; kind: string; message: string; createdAt: string };
type NyanpassRow = {
  id: string; nodeId: string; nodeName: string; name: string; role: 'inbound' | 'outbound'; panelUrl: string;
};
type NyanpassDraft = { name: string; command: string; optimize: boolean };
type CreatedNode = { token: string; installCommand: string; node: { id: string; name: string; region: string }; instances: NyanpassRow[] };
type CreatedNyanpass = { instance: NyanpassRow; installCommand: string };
type UpdatedNode = { node: NodeRow; events: EventRow[]; warnings: string[] };
type UpdatedNyanpass = { instance: NyanpassRow; installCommand: string | null; event: EventRow };

function emptyNyanpassDraft(): NyanpassDraft {
  return { name: '', command: '', optimize: false };
}

export default function Dashboard({ basePath, user, initialNodes, initialEvents, initialNyanpass }: { basePath: string; user: { name: string; email: string }; initialNodes: NodeRow[]; initialEvents: EventRow[]; initialNyanpass: NyanpassRow[] }) {
  const apiPath = (path: string) => `${basePath}${path}`;
  const [activeView, setActiveView] = useState<ViewId>('overview');
  const [nodes, setNodes] = useState(initialNodes);
  const [events, setEvents] = useState(initialEvents);
  const [nyanpass, setNyanpass] = useState(initialNyanpass);
  const [showCreate, setShowCreate] = useState(false);
  const [showNyanpass, setShowNyanpass] = useState(false);
  const [editingNode, setEditingNode] = useState<NodeRow | null>(null);
  const [editingNyanpass, setEditingNyanpass] = useState<NyanpassRow | null>(null);
  const [editedNyanpassCommand, setEditedNyanpassCommand] = useState<CreatedNyanpass | null>(null);
  const [created, setCreated] = useState<CreatedNode | null>(null);
  const [createdNyanpass, setCreatedNyanpass] = useState<CreatedNyanpass | null>(null);
  const [nodeNyanpass, setNodeNyanpass] = useState<NyanpassDraft[]>([emptyNyanpassDraft()]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingNodeId, setRemovingNodeId] = useState<string | null>(null);
  const [nodeDeleteError, setNodeDeleteError] = useState('');
  const [nodeEditNotice, setNodeEditNotice] = useState('');
  const [editError, setEditError] = useState('');
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const [now, setNow] = useState(0);
  const reported = nodes.filter((node) => Boolean(node.lastSeenAt)).length;
  const records = nodes.reduce((sum, node) => sum + Number(Boolean(node.recordV4)) + Number(Boolean(node.recordV6)), 0);

  useEffect(() => {
    const syncViewFromUrl = () => {
      const requestedView = window.location.hash.slice(1);
      setActiveView(isViewId(requestedView) ? requestedView : 'overview');
    };

    syncViewFromUrl();
    window.addEventListener('hashchange', syncViewFromUrl);
    return () => {
      window.removeEventListener('hashchange', syncViewFromUrl);
    };
  }, []);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    const initialTimer = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 30_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, []);

  async function createNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError('');
    const form = new FormData(event.currentTarget);
    const response = await fetch(apiPath('/api/admin/nodes'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(form), nyanpass: nodeNyanpass }) });
    const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as CreatedNode & { error?: string };
    setSaving(false);
    if (!response.ok) { setError(result.error ?? '创建失败'); return; }
    setCreated(result);
    setCopyFeedback('idle');
    setNyanpass((current) => [...result.instances, ...current]);
    setNodes((current) => [{
      id: result.node.id, name: result.node.name, region: result.node.region, ipv4: null, ipv6: null,
      recordV4: String(form.get('recordV4') || '') || null, recordV6: String(form.get('recordV6') || '') || null,
      lastSeenAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      provider: 'alidns', domainName: String(form.get('domainName') || '') || null,
      syncEnabled: true, tokenHash: '',
    }, ...current]);
  }

  async function createNyanpassInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError('');
    const form = new FormData(event.currentTarget);
    const response = await fetch(apiPath('/api/admin/nyanpass'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) });
    const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as CreatedNyanpass & { error?: string };
    setSaving(false);
    if (!response.ok) { setError(result.error ?? '创建失败'); return; }
    setCreatedNyanpass(result);
    setCopyFeedback('idle');
    setNyanpass((current) => [result.instance, ...current]);
  }

  async function removeNyanpassInstance(instance: NyanpassRow) {
    if (!window.confirm(`只从控制台移除 ${instance.name} 的登记，不会卸载 VPS 上的服务。继续吗？`)) return;
    const response = await fetch(apiPath(`/api/admin/nyanpass?id=${encodeURIComponent(instance.id)}`), { method: 'DELETE' });
    if (response.ok) setNyanpass((current) => current.filter((item) => item.id !== instance.id));
  }

  async function removeNode(node: NodeRow) {
    if (!window.confirm(`删除节点“${node.name}”及其事件和 Nyanpass 登记？这不会卸载 VPS 上的 DDNS 或 Nyanpass 服务。`)) return;
    setRemovingNodeId(node.id);
    setNodeDeleteError('');
    const response = await fetch(apiPath(`/api/admin/nodes?id=${encodeURIComponent(node.id)}`), { method: 'DELETE' });
    const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string };
    setRemovingNodeId(null);
    if (!response.ok) {
      setNodeDeleteError(result.error ?? '删除节点失败');
      return;
    }
    setNodes((current) => current.filter((item) => item.id !== node.id));
    setNyanpass((current) => current.filter((instance) => instance.nodeId !== node.id));
    setEvents((current) => current.filter((event) => event.nodeId !== node.id));
  }

  async function updateNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingNode) return;
    setSaving(true); setEditError(''); setNodeEditNotice('');
    const form = new FormData(event.currentTarget);
    const response = await fetch(apiPath('/api/admin/nodes'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: editingNode.id,
        name: form.get('name'),
        region: form.get('region'),
        domainName: form.get('domainName'),
        recordV4: form.get('recordV4'),
        recordV6: form.get('recordV6'),
        syncEnabled: form.get('syncEnabled') === 'on',
      }),
    });
    const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as UpdatedNode & { error?: string };
    setSaving(false);
    if (!response.ok) { setEditError(result.error ?? '修改失败'); return; }
    setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
    setNyanpass((current) => current.map((instance) => instance.nodeId === result.node.id ? { ...instance, nodeName: result.node.name } : instance));
    setEvents((current) => [...result.events, ...current.map((item) => item.nodeId === result.node.id ? { ...item, nodeName: result.node.name } : item)].slice(0, 100));
    setNodeEditNotice(result.warnings.length ? `配置已保存；${result.warnings.join('；')}` : '节点配置已保存；已有地址且启用同步时，DNS 已立即刷新。');
    setEditingNode(null);
  }

  async function updateNyanpassInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingNyanpass) return;
    setSaving(true); setEditError('');
    const form = new FormData(event.currentTarget);
    const response = await fetch(apiPath('/api/admin/nyanpass'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editingNyanpass.id, name: form.get('name'), command: form.get('command'), optimize: form.get('optimize') === 'on' }),
    });
    const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as UpdatedNyanpass & { error?: string };
    setSaving(false);
    if (!response.ok) { setEditError(result.error ?? '修改失败'); return; }
    setNyanpass((current) => current.map((instance) => instance.id === result.instance.id ? result.instance : instance));
    setEvents((current) => [result.event, ...current].slice(0, 100));
    if (result.installCommand) {
      setEditedNyanpassCommand({ instance: result.instance, installCommand: result.installCommand });
      setCopyFeedback('idle');
      return;
    }
    setEditingNyanpass(null);
  }

  function updateNodeNyanpass(index: number, field: keyof NyanpassDraft, value: string | boolean) {
    setNodeNyanpass((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  }

  async function copyInstallCommand(command: string) {
    setCopyFeedback('copying');
    setCopyFeedback(await copyText(command) ? 'success' : 'error');
  }

  function closeModal() { setShowCreate(false); setCreated(null); setNodeNyanpass([emptyNyanpassDraft()]); setError(''); setCopyFeedback('idle'); }
  function closeNyanpassModal() { setShowNyanpass(false); setCreatedNyanpass(null); setError(''); setCopyFeedback('idle'); }
  function closeNodeEditModal() { setEditingNode(null); setEditError(''); }
  function closeNyanpassEditModal() { setEditingNyanpass(null); setEditedNyanpassCommand(null); setEditError(''); setCopyFeedback('idle'); }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">P</span><span>PulseDNS</span></div>
        <nav aria-label="主导航">
          {navigation.map((item) => <a
            key={item.id}
            href={`#${item.id}`}
            className={`nav-item${activeView === item.id ? ' active' : ''}`}
            aria-current={activeView === item.id ? 'page' : undefined}
            onClick={() => setActiveView(item.id)}
          ><span aria-hidden="true">{item.icon}</span>{item.label}</a>)}
        </nav>
        <div className="sidebar-foot"><span className="health-dot" /> 主控运行正常<small>v0.7.8 · {nodes.length} 个探针</small></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">基础设施 / 动态域名</p><h1 aria-live="polite">{viewTitles[activeView]}</h1></div>
          <div className="top-actions"><span className="sync-state"><i /> 主控在线</span><span className="user-chip" title={user.email}>{user.name.slice(0, 1).toUpperCase()}</span><button className="primary-button" onClick={() => setShowCreate(true)}>＋ 添加节点</button></div>
        </header>

        <div className="content" data-view={activeView}>
          {activeView === 'overview' && <>
            <section className="hero-panel"><div><p className="eyebrow cyan">实时基础设施</p><h2>所有地址，都在正确的位置。</h2><p>探针持续监测公网 IPv4 与 IPv6，主控自动完成鉴权、DNS 同步和变更审计。</p></div><div className="pulse-orbit" aria-hidden="true"><span /><b /></div></section>
            <section className="metrics" aria-label="系统指标">
              <article><span className="metric-icon blue">⌁</span><div><small>已登记节点</small><strong>{nodes.length}</strong></div><mark>DDNS 探针</mark></article>
              <article><span className="metric-icon violet">◎</span><div><small>托管记录</small><strong>{records}</strong></div><mark>阿里云 DNS</mark></article>
              <article><span className="metric-icon green">↻</span><div><small>最近事件</small><strong>{events.length}</strong></div><mark>已审计</mark></article>
              <article><span className="metric-icon amber">!</span><div><small>已有地址上报</small><strong>{reported} <em>/ {nodes.length}</em></strong></div><mark className={nodes.length - reported ? 'warning' : ''}>{!nodes.length ? '暂无节点' : nodes.length - reported ? '等待首次上报' : '均已上报'}</mark></article>
            </section>
            <section className="grid-layout">
              <NodesPanel nodes={nodes} now={now} onCreate={() => setShowCreate(true)} onEdit={(node) => { setEditingNode(node); setEditError(''); }} onRemove={removeNode} removingNodeId={removingNodeId} deleteError={nodeDeleteError} notice={nodeEditNotice} />
              <ActivityPanel events={events} now={now} limit={5} />
            </section>
          </>}

          {activeView === 'nodes' && <section className="view-page" aria-labelledby="nodes-view-title">
            <ViewIntro eyebrow="探针管理" title="所有探针节点" id="nodes-view-title" description="查看公网地址、阿里云 DNS 映射和最近一次地址上报。原脚本只在地址首次出现或变化时上报。" />
            <NodesPanel nodes={nodes} now={now} onCreate={() => setShowCreate(true)} onEdit={(node) => { setEditingNode(node); setEditError(''); }} onRemove={removeNode} removingNodeId={removingNodeId} deleteError={nodeDeleteError} notice={nodeEditNotice} />
          </section>}

          {activeView === 'records' && <section className="view-page" aria-labelledby="records-view-title">
            <ViewIntro eyebrow="阿里云 DNS" title="动态 DNS 记录" id="records-view-title" description="每个探针上报地址后，主控会把 A 与 AAAA 记录同步到阿里云 DNS。" />
            <DnsPanel nodes={nodes} onCreate={() => setShowCreate(true)} onEdit={(node) => { setEditingNode(node); setEditError(''); }} notice={nodeEditNotice} />
          </section>}

          {activeView === 'nyanpass' && <section className="view-page" aria-labelledby="nyanpass-view-title">
            <ViewIntro eyebrow="多人合租" title="Nyanpass 合租实例" id="nyanpass-view-title" description="粘贴原脚本的官方安装命令；系统只按 rel_nodeclient 参数中是否含有独立 -o 识别入口或出口。" />
            <NyanpassPanel instances={nyanpass} hasNodes={Boolean(nodes.length)} onCreate={() => setShowNyanpass(true)} onEdit={(instance) => { setEditingNyanpass(instance); setEditedNyanpassCommand(null); setEditError(''); }} onRemove={removeNyanpassInstance} />
          </section>}

          {activeView === 'activity' && <section className="view-page" aria-labelledby="activity-view-title">
            <ViewIntro eyebrow="变更记录" title="事件日志" id="activity-view-title" description="查看探针注册、IP 变化、DNS 同步和 Nyanpass 实例登记记录。" />
            <ActivityPanel events={events} now={now} expanded />
          </section>}
        </div>
      </section>

      {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <button className="modal-close" onClick={closeModal} aria-label="关闭">×</button>
          {!created ? <><p className="eyebrow cyan">开机自动安装</p><h2 id="create-title">添加一个探针节点</h2><p className="modal-intro">先填好 SSH 密码和全部 Nyanpass 实例。生成的 Bash 脚本可直接放入云厂商开机脚本：它会等待网络、记录日志且只在首次成功时完成 SSH → DDNS 验收 → 全部 Nyanpass → BBR。</p>
            <form onSubmit={createNode} className="node-form">
              <label>节点名称<input name="name" required placeholder="例如：东京 · jp-01" /></label>
              <label>区域<input name="region" placeholder="ap-northeast" /></label>
              <label>一次性 root 密码<input name="rootPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="8-128 个字符" /></label>
              <p className="form-hint">仅写入本次生成的安装命令，用来按原脚本配置 SSH；主控不会保存密码。</p>
              <label>阿里云主域名<input name="domainName" placeholder="example.com" /></label>
              <div className="form-grid"><label>IPv4 主机记录<input name="recordV4" placeholder="home 或 @" /></label><label>IPv6 主机记录<input name="recordV6" placeholder="home 或 @" /></label></div>
              <p className="form-hint">例如 home.example.com：主域名填 example.com，主机记录填 home；根域名填 @。</p>
              <fieldset className="nyanpass-batch"><legend>Nyanpass 实例（可添加多个）</legend>{nodeNyanpass.map((instance, index) => <div className="nyanpass-draft" key={index}>
                <div className="nyanpass-draft-head"><strong>实例 {index + 1}</strong>{nodeNyanpass.length > 1 && <button type="button" className="inline-remove" onClick={() => setNodeNyanpass((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button>}</div>
                <label>服务名称<input required value={instance.name} onChange={(event) => updateNodeNyanpass(index, 'name', event.target.value)} placeholder="例如：tenant-a-out" /></label>
                <label>官方安装命令<textarea required rows={3} autoComplete="off" spellCheck={false} value={instance.command} onChange={(event) => updateNodeNyanpass(index, 'command', event.target.value)} placeholder={'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t … -u https://…"'} /></label>
                <label className="nyanpass-check"><input type="checkbox" checked={instance.optimize} onChange={(event) => updateNodeNyanpass(index, 'optimize', event.target.checked)} />启用原脚本 OPTIMIZE=1</label>
              </div>)}<button type="button" className="ghost-button" disabled={nodeNyanpass.length >= 16} onClick={() => setNodeNyanpass((current) => [...current, emptyNyanpassDraft()])}>＋ 添加另一个实例</button></fieldset>
              <p className="form-hint">命令中的独立 -o 表示出口，没有 -o 表示入口。Token 和完整命令不会存入数据库。</p>
              {error && <p className="form-error">{error}</p>}<button className="primary-button wide" disabled={saving}>{saving ? '创建中…' : '创建节点并生成一键命令'}</button>
            </form></>
          : <><p className="eyebrow cyan">节点已创建</p><h2>复制开机安装脚本</h2><p className="modal-intro">把下面完整内容直接放入云厂商的 Bash／cloud-init 开机脚本，不要再添加手工 SSH 命令。脚本会等待主控可用，日志写入 /var/log/pulsedns-bootstrap.log；安装全部成功后写入唯一标记，后续重启不会覆盖令牌或重装 Nyanpass。若中途失败，会保留 started 标记阻止盲目重复安装，并在日志中给出处理提示。</p><pre className="install-command">{created.installCommand}</pre><button type="button" className="primary-button wide" disabled={copyFeedback === 'copying'} onClick={() => copyInstallCommand(created.installCommand)}>{copyFeedback === 'copying' ? '正在复制…' : copyFeedback === 'success' ? '已复制开机脚本' : '复制完整开机脚本'}</button>{copyFeedback === 'success' && <p className="form-success" role="status">复制成功，请直接粘贴到云厂商开机脚本。</p>}{copyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动选中上方完整脚本复制；剪贴板内容没有更新。</p>}<button type="button" className="ghost-button wide" onClick={closeModal}>完成</button></>}
        </section>
      </div>}

      {showNyanpass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeNyanpassModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nyanpass-title">
          <button className="modal-close" onClick={closeNyanpassModal} aria-label="关闭">×</button>
          {!createdNyanpass ? <><p className="eyebrow cyan">多实例管理</p><h2 id="nyanpass-title">添加 Nyanpass 合租实例</h2><p className="modal-intro">直接粘贴原脚本中的官方完整命令。令牌和完整命令不会保存，只用于生成本次安装命令。</p>
            <form onSubmit={createNyanpassInstance} className="node-form"><label>所属探针节点<select name="nodeId" required defaultValue=""><option value="" disabled>选择节点</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.region}</option>)}</select></label><label>实例 / 服务名称<input name="name" required placeholder="例如：tenant-a-out" /></label><label>Nyanpass 官方安装命令<textarea name="command" required rows={4} autoComplete="off" spellCheck={false} placeholder={'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t … -u https://…"'} /></label><label className="nyanpass-check"><input name="optimize" type="checkbox" />启用原脚本 OPTIMIZE=1</label><p className="form-hint">由原命令识别：rel_nodeclient 参数含独立 -o 为出口，不含 -o 为入口；不会根据 Token、URL 或 IP 猜测。生成的命令会直接安装，不再二次确认。</p>{error && <p className="form-error">{error}</p>}<button className="primary-button wide" disabled={saving}>{saving ? '识别中…' : '识别命令并添加实例'}</button></form></>
          : <><p className="eyebrow cyan">实例已登记</p><h2>复制自动安装命令</h2><p className="modal-intro">由原命令识别为{nyanpassRoleLabel(createdNyanpass.instance.role)}：{createdNyanpass.instance.role === 'outbound' ? '含独立 -o' : '不含 -o'}。请在 {createdNyanpass.instance.nodeName} 上执行；不会再要求确认。</p><pre className="install-command">{createdNyanpass.installCommand}</pre><button type="button" className="primary-button wide" disabled={copyFeedback === 'copying'} onClick={() => copyInstallCommand(createdNyanpass.installCommand)}>{copyFeedback === 'copying' ? '正在复制…' : copyFeedback === 'success' ? '已复制安装命令' : '复制安装命令'}</button>{copyFeedback === 'success' && <p className="form-success" role="status">复制成功，请直接粘贴到目标 VPS。</p>}{copyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动选中上方完整命令复制；剪贴板内容没有更新。</p>}<button type="button" className="ghost-button wide" onClick={() => { setCreatedNyanpass(null); setError(''); setCopyFeedback('idle'); }}>继续添加一个</button><button type="button" className="ghost-button wide" onClick={closeNyanpassModal}>完成</button></>}
        </section>
      </div>}

      {editingNode && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeNodeEditModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-node-title">
          <button className="modal-close" onClick={closeNodeEditModal} aria-label="关闭">×</button>
          <p className="eyebrow cyan">修改节点</p><h2 id="edit-node-title">编辑 {editingNode.name}</h2><p className="modal-intro">修改名称、区域和阿里云 DNS 映射。探针令牌、公网地址及安装状态不会改变，也不需要重新安装探针。</p>
          <form key={editingNode.id} onSubmit={updateNode} className="node-form">
            <label>节点名称<input name="name" required defaultValue={editingNode.name} /></label>
            <label>区域<input name="region" defaultValue={editingNode.region === 'unknown' ? '' : editingNode.region} placeholder="ap-northeast" /></label>
            <label>阿里云主域名<input name="domainName" defaultValue={editingNode.domainName ?? ''} placeholder="example.com" /></label>
            <div className="form-grid"><label>IPv4 主机记录<input name="recordV4" defaultValue={editingNode.recordV4 ?? ''} placeholder="home 或 @" /></label><label>IPv6 主机记录<input name="recordV6" defaultValue={editingNode.recordV6 ?? ''} placeholder="home 或 @" /></label></div>
            <label className="nyanpass-check"><input name="syncEnabled" type="checkbox" defaultChecked={editingNode.syncEnabled} />启用阿里云 DNS 自动同步</label>
            <p className="form-hint">保存后会用当前已上报的 IP 立即刷新新记录。修改或清空映射不会自动删除旧的阿里云记录。</p>
            {editError && <p className="form-error" role="alert">{editError}</p>}
            <button className="primary-button wide" disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
          </form>
        </section>
      </div>}

      {editingNyanpass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeNyanpassEditModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-nyanpass-title">
          <button className="modal-close" onClick={closeNyanpassEditModal} aria-label="关闭">×</button>
          {!editedNyanpassCommand ? <><p className="eyebrow cyan">修改登记</p><h2 id="edit-nyanpass-title">编辑 {editingNyanpass.name}</h2><p className="modal-intro">可只修改控制台登记名称；如需改变入口/出口、Token 或面板地址，请重新粘贴官方命令，保存后会生成一次性重装命令。</p>
            <form key={editingNyanpass.id} onSubmit={updateNyanpassInstance} className="node-form">
              <label>所属探针节点<input value={editingNyanpass.nodeName} disabled /></label>
              <label>实例 / 登记名称<input name="name" required defaultValue={editingNyanpass.name} /></label>
              <label>新的官方安装命令（可选）<textarea name="command" rows={4} autoComplete="off" spellCheck={false} placeholder="留空只修改登记名称；粘贴命令则重新识别入口或出口" /></label>
              <label className="nyanpass-check"><input name="optimize" type="checkbox" />新命令启用原脚本 OPTIMIZE=1</label>
              <p className="form-hint">所属节点不能迁移。修改登记不会远程重命名、停止或卸载 VPS 上的旧服务；生成新命令后需在该节点自行执行。</p>
              {editError && <p className="form-error" role="alert">{editError}</p>}
              <button className="primary-button wide" disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
            </form></>
          : <><p className="eyebrow cyan">登记已更新</p><h2 id="edit-nyanpass-title">执行新的安装命令</h2><p className="modal-intro">新的角色和面板地址已按官方命令重新识别。请在 {editedNyanpassCommand.instance.nodeName} 执行下面命令；原 VPS 服务不会被控制台自动删除。</p><pre className="install-command">{editedNyanpassCommand.installCommand}</pre><button type="button" className="primary-button wide" disabled={copyFeedback === 'copying'} onClick={() => copyInstallCommand(editedNyanpassCommand.installCommand)}>{copyFeedback === 'copying' ? '正在复制…' : copyFeedback === 'success' ? '已复制安装命令' : '复制新的安装命令'}</button>{copyFeedback === 'success' && <p className="form-success" role="status">复制成功，请在所属 VPS 执行。</p>}{copyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动复制上方完整命令。</p>}<button type="button" className="ghost-button wide" onClick={closeNyanpassEditModal}>完成</button></>}
        </section>
      </div>}
    </main>
  );
}

function ViewIntro({ eyebrow, title, id, description }: { eyebrow: string; title: string; id: string; description: string }) {
  return <header className="view-intro">
    <p className="eyebrow cyan">{eyebrow}</p>
    <h2 id={id}>{title}</h2>
    <p>{description}</p>
  </header>;
}

function NodesPanel({ nodes, now, onCreate, onEdit, onRemove, removingNodeId, deleteError, notice }: { nodes: NodeRow[]; now: number; onCreate: () => void; onEdit: (node: NodeRow) => void; onRemove: (node: NodeRow) => void; removingNodeId: string | null; deleteError: string; notice: string }) {
  return <article className="panel nodes-panel">
    <div className="panel-heading"><div><h3>地址上报</h3><p>原探针仅在公网地址首次出现或变化时发送</p></div><button type="button" className="text-button" onClick={onCreate}>添加探针 →</button></div>
    {deleteError && <p className="panel-error" role="alert">{deleteError}</p>}
    {notice && <p className="panel-notice" role="status">{notice}</p>}
    <div className="table-wrap">
      {nodes.length ? <table><thead><tr><th>节点</th><th>公网地址 / DNS</th><th>最近地址上报</th><th>状态</th><th>操作</th></tr></thead><tbody>{nodes.map((node) => {
        const hasReported = Boolean(node.lastSeenAt);
        const removing = removingNodeId === node.id;
        return <tr key={node.id}><td><span className="node-name"><i className={hasReported ? '' : 'warn'} />{node.name}</span><small>{node.region}</small></td><td><code>{node.ipv4 ?? '等待 IPv4 上报'}{node.recordV4 ? ` → ${fqdn(node.domainName, node.recordV4)}` : ''}</code><code>{node.ipv6 ?? '等待 IPv6 上报'}{node.recordV6 ? ` → ${fqdn(node.domainName, node.recordV6)}` : ''}</code></td><td>{relativeTime(node.lastSeenAt, now)}</td><td><span className={hasReported ? 'badge online' : 'badge warning'}>{hasReported ? '已上报' : '等待首次上报'}</span></td><td><div className="row-actions"><button type="button" className="edit-link" disabled={removing} onClick={() => onEdit(node)}>修改</button><button type="button" className="danger-link" disabled={removing} onClick={() => onRemove(node)}>{removing ? '删除中…' : '删除节点'}</button></div></td></tr>;
      })}</tbody></table> : <EmptyState onCreate={onCreate} />}
    </div>
  </article>;
}

function DnsPanel({ nodes, onCreate, onEdit, notice }: { nodes: NodeRow[]; onCreate: () => void; onEdit: (node: NodeRow) => void; notice: string }) {
  return <article className="panel dns-panel">
    <div className="panel-heading"><div><h3>托管记录</h3><p>Provider：阿里云 DNS（AliDNS）</p></div><button type="button" className="text-button" onClick={onCreate}>添加记录所属节点 →</button></div>
    {notice && <p className="panel-notice" role="status">{notice}</p>}
    <div className="table-wrap">
      {nodes.length ? <table><thead><tr><th>节点 / 主域名</th><th>A 记录</th><th>AAAA 记录</th><th>同步</th><th>操作</th></tr></thead><tbody>{nodes.map((node) => <tr key={node.id}>
        <td><span className="node-name"><i className={node.syncEnabled ? '' : 'warn'} />{node.name}</span><small>{node.domainName ?? '未配置主域名'}</small></td>
        <td>{node.recordV4 ? <><code>{fqdn(node.domainName, node.recordV4)}</code><small>{node.ipv4 ?? '等待 IPv4 上报'}</small></> : <span className="muted-value">未配置</span>}</td>
        <td>{node.recordV6 ? <><code>{fqdn(node.domainName, node.recordV6)}</code><small>{node.ipv6 ?? '等待 IPv6 上报'}</small></> : <span className="muted-value">未配置</span>}</td>
        <td><span className={node.syncEnabled ? 'badge online' : 'badge warning'}>{node.syncEnabled ? '自动同步' : '已暂停'}</span></td>
        <td><button type="button" className="edit-link" onClick={() => onEdit(node)}>修改记录</button></td>
      </tr>)}</tbody></table> : <EmptyState onCreate={onCreate} />}
    </div>
  </article>;
}

function ActivityPanel({ events, now, limit, expanded = false }: { events: EventRow[]; now: number; limit?: number; expanded?: boolean }) {
  const [nodeFilter, setNodeFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const filter = { nodeId: nodeFilter, category: categoryFilter, level: levelFilter, query };
  const matchingEvents = filterEvents(events, filter);
  const visibleEvents = filterEvents(events, filter, limit);
  const hasFilters = nodeFilter !== 'all' || categoryFilter !== 'all' || levelFilter !== 'all' || Boolean(query.trim());
  const nodeOptions = Array.from(new Map(events.map((event) => [event.nodeId, event.nodeName])).entries());
  const nodeNameCounts = new Map<string, number>();
  nodeOptions.forEach(([, name]) => nodeNameCounts.set(name, (nodeNameCounts.get(name) ?? 0) + 1));
  const contentId = expanded ? 'activity-log-content' : 'recent-changes-content';
  const clearFilters = () => { setNodeFilter('all'); setCategoryFilter('all'); setLevelFilter('all'); setQuery(''); };
  return <article className={`panel activity-panel${expanded ? ' activity-page' : ''}`}>
    <div className="panel-heading"><div><h3>{expanded ? '事件记录' : '最近变更'}</h3><p>{expanded ? '筛选当前加载的最近 100 条事件' : '筛选主控最近处理的事件'}</p></div><div className="activity-heading-actions"><span className="live">LOG</span>{expanded && <button type="button" className="collapse-button" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed((value) => !value)}>{collapsed ? '展开' : '折叠'}</button>}</div></div>
    <div id={contentId} hidden={collapsed}>
      <div className="activity-toolbar" aria-label={`${expanded ? '事件日志' : '最近变更'}筛选`}>
        <label><span>节点</span><select value={nodeFilter} onChange={(event) => setNodeFilter(event.target.value)}><option value="all">全部节点</option>{nodeOptions.map(([id, name]) => <option value={id} key={id}>{name}{(nodeNameCounts.get(name) ?? 0) > 1 ? ` · ${id.slice(0, 6)}` : ''}</option>)}</select></label>
        <label><span>类型</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">全部类型</option><option value="node">节点</option><option value="ip">IP 变化</option><option value="dns">DNS</option><option value="nyanpass">Nyanpass</option><option value="other">其他</option></select></label>
        <label><span>级别</span><select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)}><option value="all">全部级别</option><option value="info">正常</option><option value="error">错误</option></select></label>
        <label className="activity-search"><span>关键词</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="消息、节点或事件类型" /></label>
        <div className="filter-summary" aria-live="polite"><span>{matchingEvents.length} 条匹配</span>{hasFilters && <button type="button" onClick={clearFilters}>清除筛选</button>}</div>
      </div>
      <div className="activity-list">{visibleEvents.length ? visibleEvents.map((item) => <div className="activity-row" key={item.id}><span className={item.level === 'error' ? 'activity-check error' : 'activity-check'}>{item.level === 'error' ? '!' : '✓'}</span><div><strong>{item.message}</strong><p>{item.nodeName} · {eventKindLabel(item.kind)}</p></div><time title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt, now)}</time></div>) : <p className="empty-activity">{events.length && hasFilters ? '没有符合当前筛选条件的事件。' : '创建第一个节点后，DNS 同步与探针事件会出现在这里。'}</p>}</div>
      <div className="security-note"><span>◇</span><div><strong>独立探针凭据</strong><p>令牌只显示一次，数据库仅保存 SHA-256 摘要。</p></div></div>
    </div>
  </article>;
}

function NyanpassPanel({ instances, hasNodes, onCreate, onEdit, onRemove }: { instances: NyanpassRow[]; hasNodes: boolean; onCreate: () => void; onEdit: (instance: NyanpassRow) => void; onRemove: (instance: NyanpassRow) => void }) {
  return <article className="panel nyanpass-panel">
    <div className="panel-heading"><div><h3>已登记实例</h3><p>一个探针可登记多个面板节点；角色只由原命令中的独立 -o 识别</p></div><button type="button" className="primary-button compact" onClick={onCreate} disabled={!hasNodes}>＋ 添加实例</button></div>
    <div className="table-wrap">
      {instances.length ? <table><thead><tr><th>实例 / 所属节点</th><th>面板</th><th>由原命令识别</th><th>登记</th><th>操作</th></tr></thead><tbody>{instances.map((instance) => <tr key={instance.id}><td><span className="node-name">{instance.name}</span><small>{instance.nodeName}</small></td><td><code>{displayHost(instance.panelUrl)}</code></td><td><b className={`role-badge ${instance.role}`}>{nyanpassRoleLabel(instance.role)}</b><small>{instance.role === 'outbound' ? '含独立 -o' : '不含 -o'}</small></td><td><span className="badge online">已登记</span></td><td><div className="row-actions"><button type="button" className="edit-link" onClick={() => onEdit(instance)}>修改</button><button type="button" className="danger-link" onClick={() => onRemove(instance)}>移除登记</button></div></td></tr>)}</tbody></table> : <div className="empty-state compact-empty"><span>⇄</span><h4>还没有合租实例</h4><p>{hasNodes ? '添加第一个 Nyanpass 实例；同一节点可以继续添加多个。' : '请先创建探针节点，再添加 Nyanpass 合租实例。'}</p><button type="button" className="ghost-button" disabled={!hasNodes} onClick={onCreate}>添加实例</button></div>}
    </div>
  </article>;
}

function fqdn(domainName: string | null, rr: string) {
  if (!domainName) return rr;
  return rr === '@' ? domainName : `${rr}.${domainName}`;
}

function displayHost(value: string) {
  try { return new URL(value).host; } catch { return value; }
}

function nyanpassRoleLabel(role: string) {
  return role === 'inbound' ? '入口' : '出口';
}

function eventKindLabel(kind: string) {
  const labels: Record<string, string> = {
    node_created: '节点创建',
    node_updated: '节点修改',
    ip_changed: 'IP 变化',
    dns_synced: 'DNS 同步',
    dns_failed: 'DNS 失败',
    nyanpass_created: 'Nyanpass 添加',
    nyanpass_updated: 'Nyanpass 修改',
  };
  return labels[kind] ?? kind;
}

function relativeTime(value: string | null, now: number) {
  if (!value) return '从未';
  if (!now) return '计算中';
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-state"><span>⌁</span><h4>还没有探针节点</h4><p>添加节点后会获得独立令牌和一键安装命令。</p><button type="button" className="ghost-button" onClick={onCreate}>创建第一个节点</button></div>;
}
