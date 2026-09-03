'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/copy-text';
import { filterEvents } from '@/lib/event-filter';
import { PROBE_INSTALLER_SHA256, PROBE_INSTALLER_URL } from '@/lib/install-command';

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
  provider: string; domainName: string | null; syncEnabled: boolean;
  agentVersion: string | null; lastTaskPollAt: string | null; nyanpassStatus: string;
  provisionLastCompletedStep: string | null;
};
type EventRow = { id: number; nodeId: string; nodeName: string; level: string; kind: string; message: string; createdAt: string };
type NyanpassStatusValue = 'ready' | 'pending' | 'running' | 'success' | 'failed' | 'uncertain' | 'bootstrap' | 'legacy' | '等待安装';
type NyanpassRow = {
  id: string; nodeId: string; nodeName: string; name: string; role: 'inbound' | 'outbound'; panelUrl: string;
  optimize: boolean;
  status: NyanpassStatusValue; lastReportedAt: string | null; syncError: string | null; activeTaskId: string | null; configRevision: number;
  hasCredential: boolean;
  taskStatus: string | null; taskCreatedAt: string | null; taskClaimedAt: string | null; taskLeaseExpiresAt: string | null;
};
type NyanpassDraft = { name: string; command: string; optimize: boolean };
type CreatedNode = { installUrl: string; connectCommand: string; startupScript: string; node: { id: string; name: string; region: string }; instances: NyanpassRow[] };
type CreatedNyanpass = { instance: NyanpassRow };
type UpdatedNode = { node: NodeRow; events: EventRow[]; warnings: string[] };
type UpdatedNyanpass = { instance: NyanpassRow; event: EventRow };

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
  const [created, setCreated] = useState<CreatedNode | null>(null);
  const [createdNyanpass, setCreatedNyanpass] = useState<CreatedNyanpass | null>(null);
  const [nodeNyanpass, setNodeNyanpass] = useState<NyanpassDraft[]>([emptyNyanpassDraft()]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removingNodeId, setRemovingNodeId] = useState<string | null>(null);
  const [nodeDeleteError, setNodeDeleteError] = useState('');
  const [nodeEditNotice, setNodeEditNotice] = useState('');
  const [editError, setEditError] = useState('');
  const [syncingNyanpassIds, setSyncingNyanpassIds] = useState<Set<string>>(new Set());
  const [nyanpassErrors, setNyanpassErrors] = useState<Record<string, string>>({});
  const [agentUpgrade, setAgentUpgrade] = useState<{ nodeId: string; nodeName: string; command: string } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const [startupCopyFeedback, setStartupCopyFeedback] = useState<'idle' | 'copying' | 'success' | 'error'>('idle');
  const [now, setNow] = useState(0);
  const [insecureTransport, setInsecureTransport] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [lastSuccessfulRefresh, setLastSuccessfulRefresh] = useState(0);
  const refreshSequence = useRef(0);
  const nyanpassRef = useRef(initialNyanpass);
  const reported = nodes.filter((node) => Boolean(node.lastSeenAt)).length;
  const records = nodes.reduce((sum, node) => sum + Number(Boolean(node.recordV4)) + Number(Boolean(node.recordV6)), 0);
  const hasActiveNyanpassSync = nyanpass.some((instance) => instance.status === 'pending' || instance.status === 'running');

  useEffect(() => {
    nyanpassRef.current = nyanpass;
  }, [nyanpass]);

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
    let stopped = false;
    let activeController: AbortController | null = null;
    const refresh = async () => {
      if (document.hidden) return;
      activeController?.abort();
      activeController = new AbortController();
      const sequence = ++refreshSequence.current;
      try {
        const response = await fetch(`${basePath}/api/admin/nyanpass`, { cache: 'no-store', signal: activeController.signal });
        if (!response.ok) throw new Error(`管理接口返回 HTTP ${response.status}`);
        const result = await response.json() as { instances?: NyanpassRow[]; nodes?: NodeRow[]; events?: EventRow[] };
        if (!Array.isArray(result.instances) || !Array.isArray(result.nodes) || !Array.isArray(result.events)) throw new Error('管理接口返回内容不完整');
        if (stopped || sequence !== refreshSequence.current) return;
        const refreshedInstances = result.instances;
        const refreshedNodes = result.nodes;
        const previousInstances = nyanpassRef.current;
        nyanpassRef.current = refreshedInstances;
        setRefreshError('');
        setLastSuccessfulRefresh(Date.now());
        setNyanpass(refreshedInstances);
        setCreatedNyanpass((current) => {
          if (!current) return null;
          const updated = refreshedInstances.find((instance) => instance.id === current.instance.id);
          return updated ? { instance: updated } : null;
        });
        setNodes(refreshedNodes);
        setNyanpassErrors((current) => {
          const next = { ...current };
          const refreshTime = Date.now();
          const refreshedIds = new Set(refreshedInstances.map((instance) => instance.id));
          for (const instanceId of Object.keys(next)) {
            if (!refreshedIds.has(instanceId)) delete next[instanceId];
          }
          for (const instance of refreshedInstances) {
            const message = next[instance.id];
            const node = refreshedNodes.find((item) => item.id === instance.nodeId);
            const previous = previousInstances.find((item) => item.id === instance.id);
            const authoritativeStateChanged = Boolean(previous && (
              previous.status !== instance.status
              || previous.activeTaskId !== instance.activeTaskId
              || previous.configRevision !== instance.configRevision
              || previous.syncError !== instance.syncError
            ));
            if (message && authoritativeStateChanged) delete next[instance.id];
            else if (message?.startsWith('探针最近 2 分钟') && node && nodeCanQueueTasks(node, refreshedInstances, refreshTime)) delete next[instance.id];
          }
          return next;
        });
        setEvents(result.events);
      } catch (cause) {
        if (stopped || sequence !== refreshSequence.current || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        setRefreshError(cause instanceof Error ? cause.message : '无法连接管理接口');
      }
    };
    const timer = window.setInterval(refresh, hasActiveNyanpassSync || agentUpgrade ? 4_000 : 30_000);
    const refreshWhenVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    void refresh();
    return () => { stopped = true; activeController?.abort(); document.removeEventListener('visibilitychange', refreshWhenVisible); window.clearInterval(timer); };
  }, [basePath, hasActiveNyanpassSync, agentUpgrade]);

  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    const transportTimer = window.setTimeout(() => setInsecureTransport(window.location.protocol === 'http:'), 0);
    const initialTimer = window.setTimeout(updateClock, 0);
    const interval = window.setInterval(updateClock, 30_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearTimeout(transportTimer);
      window.clearInterval(interval);
    };
  }, []);

  async function createNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetchWithTimeout(apiPath('/api/admin/nodes'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(form), nyanpass: nodeNyanpass }) });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as CreatedNode & { error?: string };
      if (!response.ok) { setError(result.error ?? '创建失败'); return; }
      refreshSequence.current += 1;
      setCreated(result);
      setCopyFeedback('idle');
      setStartupCopyFeedback('idle');
      setNyanpass((current) => [...result.instances, ...current]);
      setNodes((current) => [{
        id: result.node.id, name: result.node.name, region: result.node.region, ipv4: null, ipv6: null,
        recordV4: String(form.get('recordV4') || '') || null, recordV6: String(form.get('recordV6') || '') || null,
        lastSeenAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        provider: 'alidns', domainName: String(form.get('domainName') || '') || null,
        syncEnabled: true, agentVersion: null, lastTaskPollAt: null, nyanpassStatus: 'awaiting', provisionLastCompletedStep: null,
      }, ...current]);
    } catch {
      setError('无法确认节点是否创建成功，请刷新页面核对后再操作。');
    } finally {
      setSaving(false);
    }
  }

  async function createNyanpassInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetchWithTimeout(apiPath('/api/admin/nyanpass'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as CreatedNyanpass & { error?: string };
      if (!response.ok) { setError(result.error ?? '创建失败'); return; }
      refreshSequence.current += 1;
      setCreatedNyanpass(result);
      setNyanpass((current) => [result.instance, ...current]);
    } catch {
      setError('无法确认实例是否保存成功，请刷新页面核对后再操作。');
    } finally {
      setSaving(false);
    }
  }

  async function removeNyanpassInstance(instance: NyanpassRow) {
    const confirmation = instance.status === 'uncertain'
      ? `实例 ${instance.name} 的上次执行结果未知，原探针仍可能回传。请先到 VPS 确认安装进程已结束；移除后会失去晚到回执关联，也不会卸载机器上的服务。确认已经核查并继续吗？`
      : `只从控制台移除 ${instance.name} 的登记，不会卸载 VPS 上的服务。继续吗？`;
    if (!window.confirm(confirmation)) return;
    setSyncingNyanpassIds((current) => new Set(current).add(instance.id));
    try {
      const uncertainConfirmation = instance.status === 'uncertain' ? '&confirmUncertain=checked' : '';
      const response = await fetchWithTimeout(apiPath(`/api/admin/nyanpass?id=${encodeURIComponent(instance.id)}${uncertainConfirmation}`), { method: 'DELETE' });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string };
      if (!response.ok) { setNyanpassErrors((current) => ({ ...current, [instance.id]: result.error ?? '移除失败' })); return; }
      refreshSequence.current += 1;
      setNyanpass((current) => current.filter((item) => item.id !== instance.id));
    } catch {
      setNyanpassErrors((current) => ({ ...current, [instance.id]: '无法确认是否已移除，请刷新页面核对。' }));
    } finally {
      setSyncingNyanpassIds((current) => { const next = new Set(current); next.delete(instance.id); return next; });
    }
  }

  async function syncNyanpassInstance(instance: NyanpassRow) {
    const node = nodes.find((item) => item.id === instance.nodeId);
    if (node && isBootstrapLockedStatus(node.nyanpassStatus)) {
      setNyanpassErrors((current) => ({ ...current, [instance.id]: '节点的首次预配尚未安全完成，请先执行或按日志恢复同一条探针对接命令。' }));
      return;
    }
    if (!node || !supportsRemoteSync(node.agentVersion)) {
      if (node) showAgentUpgrade(node);
      return;
    }
    if (!nodeCanQueueTasks(node, nyanpass, now)) {
      setNyanpassErrors((current) => ({ ...current, [instance.id]: '探针最近 2 分钟没有任务心跳，也没有正在执行的有效任务，请检查 VPS 上的 ddns-monitor 服务和网络。' }));
      return;
    }
    setSyncingNyanpassIds((current) => new Set(current).add(instance.id));
    setNyanpassErrors((current) => ({ ...current, [instance.id]: '' }));
    try {
      const response = await fetchWithTimeout(apiPath('/api/admin/nyanpass/sync'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: instance.id }) });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as CreatedNyanpass & { error?: string };
      if (!response.ok) {
        setNyanpassErrors((current) => ({ ...current, [instance.id]: result.error ?? '同步下发失败' }));
        return;
      }
      refreshSequence.current += 1;
      setNyanpass((current) => current.map((item) => item.id === result.instance.id ? result.instance : item));
      setCreatedNyanpass((current) => current?.instance.id === result.instance.id ? result : current);
    } catch {
      setNyanpassErrors((current) => ({ ...current, [instance.id]: '无法连接主控，任务没有确认下发，请稍后重试。' }));
    } finally {
      setSyncingNyanpassIds((current) => { const next = new Set(current); next.delete(instance.id); return next; });
    }
  }

  async function cancelNyanpassSync(instance: NyanpassRow) {
    if (!window.confirm(`取消 ${instance.name} 尚未领取的排队任务？已保存的配置会保留。`)) return;
    setSyncingNyanpassIds((current) => new Set(current).add(instance.id));
    setNyanpassErrors((current) => ({ ...current, [instance.id]: '' }));
    try {
      const response = await fetchWithTimeout(apiPath(`/api/admin/nyanpass/sync?id=${encodeURIComponent(instance.id)}`), { method: 'DELETE' });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string };
      if (!response.ok) {
        setNyanpassErrors((current) => ({ ...current, [instance.id]: result.error ?? '取消排队失败' }));
        return;
      }
      refreshSequence.current += 1;
      setNyanpass((current) => current.map((item) => item.id === instance.id ? { ...item, status: 'ready', activeTaskId: null, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null, syncError: '排队已取消，配置仍可再次同步' } : item));
      setCreatedNyanpass((current) => current?.instance.id === instance.id ? { instance: { ...current.instance, status: 'ready', activeTaskId: null, taskStatus: null, taskCreatedAt: null, taskClaimedAt: null, taskLeaseExpiresAt: null, syncError: '排队已取消，配置仍可再次同步' } } : current);
    } catch {
      setNyanpassErrors((current) => ({ ...current, [instance.id]: '无法连接主控，无法确认是否已经取消。' }));
    } finally {
      setSyncingNyanpassIds((current) => { const next = new Set(current); next.delete(instance.id); return next; });
    }
  }

  function showAgentUpgrade(node: NodeRow) {
    if (saving) return;
    const resumeCreatedInstance = Boolean(showNyanpass && createdNyanpass?.instance.nodeId === node.id);
    setShowCreate(false); setShowNyanpass(false); setEditingNode(null); setEditingNyanpass(null);
    setCreated(null); setNodeNyanpass([emptyNyanpassDraft()]);
    if (!resumeCreatedInstance) setCreatedNyanpass(null);
    setError(''); setEditError('');
    setAgentUpgrade({ nodeId: node.id, nodeName: node.name, command: `( tmp="$(mktemp)" && trap 'rm -f "$tmp"' EXIT && curl --proto '=https' --proto-redir '=https' -fsSL '${PROBE_INSTALLER_URL}' -o "$tmp" && test "$(sha256sum "$tmp" | awk '{print $1}')" = '${PROBE_INSTALLER_SHA256}' && grep -Fq '# PulseDNS / 原 DDNS 脚本兼容安装器' "$tmp" && bash -n "$tmp" && bash "$tmp" agent-upgrade )` });
    setCopyFeedback('idle');
  }

  async function removeNode(node: NodeRow) {
    const hasKnownUncertain = node.nyanpassStatus === 'failed'
      || nyanpass.some((instance) => instance.nodeId === node.id && instance.status === 'uncertain');
    const confirmation = isBootstrapLockedStatus(node.nyanpassStatus)
      ? `节点“${node.name}”尚未完成开机安装。请确认还没有执行脚本，或已经在 VPS 停止安装；删除只清理控制台登记，不会停止或卸载机器上的服务。继续吗？`
      : hasKnownUncertain
        ? `节点“${node.name}”存在结果未知的安装。请先到 VPS 确认所有安装进程已经结束；删除会失去晚到回执关联，也不会卸载机器上的服务。确认已经核查并继续吗？`
      : `删除节点“${node.name}”及其事件和 Nyanpass 登记？这不会卸载 VPS 上的 DDNS 或 Nyanpass 服务。`;
    if (!window.confirm(confirmation)) return;
    setRemovingNodeId(node.id);
    setNodeDeleteError('');
    try {
      const provisionConfirmation = isBootstrapLockedStatus(node.nyanpassStatus) ? '&confirmProvisioning=checked' : '';
      const uncertainConfirmation = hasKnownUncertain ? '&confirmUncertain=checked' : '';
      const deleteRequest = (extraConfirmation = '') => fetchWithTimeout(apiPath(`/api/admin/nodes?id=${encodeURIComponent(node.id)}${provisionConfirmation}${uncertainConfirmation}${extraConfirmation}`), { method: 'DELETE' });
      let response = await deleteRequest();
      let result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string; requiresUncertainConfirmation?: boolean };
      if (!response.ok && result.requiresUncertainConfirmation && !hasKnownUncertain) {
        const verified = window.confirm(`主控检测到节点“${node.name}”还有旧的结果未知任务。请先到 VPS 确认安装进程已经结束；删除后无法再接收回执。确认已经核查并继续吗？`);
        if (!verified) { setNodeDeleteError(result.error ?? '已取消删除'); return; }
        response = await deleteRequest('&confirmUncertain=checked');
        result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as { error?: string; requiresUncertainConfirmation?: boolean };
      }
      if (!response.ok) { setNodeDeleteError(result.error ?? '删除节点失败'); return; }
      refreshSequence.current += 1;
      setNodes((current) => current.filter((item) => item.id !== node.id));
      setNyanpass((current) => current.filter((instance) => instance.nodeId !== node.id));
      setEvents((current) => current.filter((event) => event.nodeId !== node.id));
    } catch {
      setNodeDeleteError('无法确认节点是否已经删除，请刷新页面核对。');
    } finally {
      setRemovingNodeId(null);
    }
  }

  async function updateNode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingNode) return;
    setSaving(true); setEditError(''); setNodeEditNotice('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetchWithTimeout(apiPath('/api/admin/nodes'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingNode.id, name: form.get('name'), region: form.get('region'), domainName: form.get('domainName'), recordV4: form.get('recordV4'), recordV6: form.get('recordV6'), syncEnabled: form.get('syncEnabled') === 'on' }),
      });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as UpdatedNode & { error?: string };
      if (!response.ok) { setEditError(result.error ?? '修改失败'); return; }
      refreshSequence.current += 1;
      setNodes((current) => current.map((node) => node.id === result.node.id ? result.node : node));
      setNyanpass((current) => current.map((instance) => instance.nodeId === result.node.id ? { ...instance, nodeName: result.node.name } : instance));
      setEvents((current) => [...result.events, ...current.map((item) => item.nodeId === result.node.id ? { ...item, nodeName: result.node.name } : item)].slice(0, 100));
      setNodeEditNotice(result.warnings.length ? `配置已保存；${result.warnings.join('；')}` : '节点配置已保存；已有地址且启用同步时，DNS 已立即刷新。');
      setEditingNode(null);
    } catch {
      setEditError('无法确认修改是否保存成功，请刷新页面核对后再操作。');
    } finally {
      setSaving(false);
    }
  }

  async function updateNyanpassInstance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingNyanpass) return;
    setSaving(true); setEditError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetchWithTimeout(apiPath('/api/admin/nyanpass'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingNyanpass.id,
          name: editingNyanpass.name,
          command: form.get('command'),
          optimize: form.get('optimize') === 'on',
          confirmUncertain: editingNyanpass.status === 'uncertain' ? 'checked' : undefined,
        }),
      });
      const result = await response.json().catch(() => ({ error: '主控返回了无效响应' })) as UpdatedNyanpass & { error?: string };
      if (!response.ok) { setEditError(result.error ?? '修改失败'); return; }
      refreshSequence.current += 1;
      setNyanpass((current) => current.map((instance) => instance.id === result.instance.id ? result.instance : instance));
      setNyanpassErrors((current) => { const next = { ...current }; delete next[result.instance.id]; return next; });
      setEvents((current) => [result.event, ...current].slice(0, 100));
      setEditingNyanpass(null);
    } catch {
      setEditError('无法确认修改是否保存成功，请刷新页面核对后再操作。');
    } finally {
      setSaving(false);
    }
  }

  function updateNodeNyanpass(index: number, field: keyof NyanpassDraft, value: string | boolean) {
    setNodeNyanpass((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  }

  async function copyInstallCommand(command: string) {
    setCopyFeedback('copying');
    setCopyFeedback(await copyText(command) ? 'success' : 'error');
  }

  async function copyStartupScript(script: string) {
    setStartupCopyFeedback('copying');
    setStartupCopyFeedback(await copyText(script) ? 'success' : 'error');
  }

  function closeModal() {
    if (saving) return;
    setShowCreate(false); setCreated(null); setNodeNyanpass([emptyNyanpassDraft()]); setError(''); setCopyFeedback('idle'); setStartupCopyFeedback('idle');
  }
  function closeNyanpassModal() {
    if (saving) return;
    setShowNyanpass(false); setCreatedNyanpass(null); setError(''); setCopyFeedback('idle');
  }
  function closeNodeEditModal() {
    if (saving) return;
    setEditingNode(null); setEditError('');
  }
  function closeNyanpassEditModal() {
    if (saving) return;
    setEditingNyanpass(null); setEditError('');
  }
  function openCreateModal() {
    if (saving) return;
    setShowNyanpass(false); setEditingNode(null); setEditingNyanpass(null); setAgentUpgrade(null);
    setCreated(null); setCreatedNyanpass(null); setNodeNyanpass([emptyNyanpassDraft()]);
    setError(''); setEditError(''); setCopyFeedback('idle'); setStartupCopyFeedback('idle'); setShowCreate(true);
  }
  function openNyanpassModal() {
    if (saving) return;
    setShowCreate(false); setEditingNode(null); setEditingNyanpass(null); setAgentUpgrade(null);
    setCreated(null); setCreatedNyanpass(null); setNodeNyanpass([emptyNyanpassDraft()]);
    setError(''); setEditError(''); setCopyFeedback('idle'); setShowNyanpass(true);
  }
  function beginNodeEdit(node: NodeRow) {
    if (saving) return;
    setShowCreate(false); setShowNyanpass(false); setEditingNyanpass(null); setAgentUpgrade(null);
    setCreated(null); setCreatedNyanpass(null); setNodeNyanpass([emptyNyanpassDraft()]);
    setError(''); setCopyFeedback('idle'); setEditingNode(node); setEditError('');
  }
  function beginNyanpassEdit(instance: NyanpassRow) {
    if (saving) return;
    if (instance.status === 'uncertain' && !window.confirm('请先到 VPS 确认旧任务已停止。结果未知时重新同步可能重复安装；确认已经检查并继续修改吗？')) return;
    setShowCreate(false); setShowNyanpass(false); setEditingNode(null); setAgentUpgrade(null);
    setCreated(null); setCreatedNyanpass(null); setNodeNyanpass([emptyNyanpassDraft()]);
    setError(''); setCopyFeedback('idle'); setEditingNyanpass(instance); setEditError('');
  }
  const upgradedAgentNode = agentUpgrade ? nodes.find((node) => node.id === agentUpgrade.nodeId) : null;
  const agentUpgradeReady = Boolean(upgradedAgentNode && supportsRemoteSync(upgradedAgentNode.agentVersion) && hasRecentTaskPoll(upgradedAgentNode, now));
  const createdNyanpassNode = createdNyanpass ? nodes.find((node) => node.id === createdNyanpass.instance.nodeId) : null;
  const createdNyanpassNodeReady = Boolean(createdNyanpassNode && supportsRemoteSync(createdNyanpassNode.agentVersion) && nodeCanQueueTasks(createdNyanpassNode, nyanpass, now));
  const editingNyanpassRequiresCommand = Boolean(editingNyanpass && requiresFreshNyanpassCommand(editingNyanpass));
  const hasModal = showCreate || showNyanpass || Boolean(editingNode) || Boolean(editingNyanpass) || Boolean(agentUpgrade);

  return (
    <main className="app-shell">
      <aside className="sidebar" inert={hasModal}>
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
        <div className="sidebar-foot"><span className="health-dot" /> 主控运行正常<small>v0.8.2 · {nodes.length} 个探针</small></div>
      </aside>

      <section className="workspace" inert={hasModal}>
        <header className="topbar">
          <div><p className="eyebrow">基础设施 / 动态域名</p><h1 aria-live="polite">{viewTitles[activeView]}</h1></div>
          <div className="top-actions"><span className={`sync-state${refreshError ? ' error' : ''}`} title={refreshError || (lastSuccessfulRefresh ? `上次刷新：${new Date(lastSuccessfulRefresh).toLocaleTimeString()}` : '页面已由主控加载')}><i /> {refreshError ? '状态刷新失败' : '主控在线'}</span><span className="user-chip" title={user.email}>{user.name.slice(0, 1).toUpperCase()}</span><button className="primary-button" onClick={openCreateModal}>＋ 添加节点</button></div>
        </header>

        <div className="content" data-view={activeView}>
          {refreshError && <p className="transport-warning" role="alert"><strong>状态刷新中断：</strong>{refreshError}。当前状态可能已过期，系统会自动重试{lastSuccessfulRefresh ? `；上次成功刷新于 ${new Date(lastSuccessfulRefresh).toLocaleTimeString()}` : ''}。</p>}
          {activeView === 'overview' && <>
            <section className="hero-panel"><div><p className="eyebrow cyan">实时基础设施</p><h2>所有地址，都在正确的位置。</h2><p>探针持续监测公网 IPv4 与 IPv6，主控自动完成鉴权、DNS 同步和变更审计。</p></div><div className="pulse-orbit" aria-hidden="true"><span /><b /></div></section>
            <section className="metrics" aria-label="系统指标">
              <article><span className="metric-icon blue">⌁</span><div><small>已登记节点</small><strong>{nodes.length}</strong></div><mark>DDNS 探针</mark></article>
              <article><span className="metric-icon violet">◎</span><div><small>托管记录</small><strong>{records}</strong></div><mark>阿里云 DNS</mark></article>
              <article><span className="metric-icon green">↻</span><div><small>最近事件</small><strong>{events.length}</strong></div><mark>已审计</mark></article>
              <article><span className="metric-icon amber">!</span><div><small>已有地址上报</small><strong>{reported} <em>/ {nodes.length}</em></strong></div><mark className={nodes.length - reported ? 'warning' : ''}>{!nodes.length ? '暂无节点' : nodes.length - reported ? '等待首次上报' : '均已上报'}</mark></article>
            </section>
            <section className="grid-layout">
              <NodesPanel nodes={nodes} now={now} onCreate={openCreateModal} onEdit={beginNodeEdit} onRemove={removeNode} removingNodeId={removingNodeId} deleteError={nodeDeleteError} notice={nodeEditNotice} />
              <ActivityPanel events={events} now={now} limit={5} />
            </section>
          </>}

          {activeView === 'nodes' && <section className="view-page" aria-labelledby="nodes-view-title">
            <ViewIntro eyebrow="探针管理" title="所有探针节点" id="nodes-view-title" description="查看公网地址、阿里云 DNS 映射和最近一次地址上报。原脚本只在地址首次出现或变化时上报。" />
            <NodesPanel nodes={nodes} now={now} onCreate={openCreateModal} onEdit={beginNodeEdit} onRemove={removeNode} removingNodeId={removingNodeId} deleteError={nodeDeleteError} notice={nodeEditNotice} />
          </section>}

          {activeView === 'records' && <section className="view-page" aria-labelledby="records-view-title">
            <ViewIntro eyebrow="阿里云 DNS" title="动态 DNS 记录" id="records-view-title" description="每个探针上报地址后，主控会把 A 与 AAAA 记录同步到阿里云 DNS。" />
            <DnsPanel nodes={nodes} onCreate={openCreateModal} onEdit={beginNodeEdit} notice={nodeEditNotice} />
          </section>}

          {activeView === 'nyanpass' && <section className="view-page" aria-labelledby="nyanpass-view-title">
            <ViewIntro eyebrow="多人合租 · 受限远程同步" title="Nyanpass 合租实例" id="nyanpass-view-title" description="保存新的官方命令后，点击同步到机器；探针只会领取固定类型的 Nyanpass 安装任务，不接受任意 Shell。" />
            {insecureTransport && <p className="transport-warning" role="alert"><strong>当前是 HTTP：</strong>随机路径只能降低误访问，不能加密节点令牌或 Nyanpass Token。仅在可信网络并把面板端口限制到自己的来源 IP；需要链路保密时请改用 HTTPS。</p>}
            <NyanpassPanel instances={nyanpass} nodes={nodes} hasNodes={Boolean(nodes.length)} syncingIds={syncingNyanpassIds} errors={nyanpassErrors} now={now} onCreate={openNyanpassModal} onEdit={beginNyanpassEdit} onRemove={removeNyanpassInstance} onSync={syncNyanpassInstance} onCancel={cancelNyanpassSync} onUpgrade={showAgentUpgrade} />
          </section>}

          {activeView === 'activity' && <section className="view-page" aria-labelledby="activity-view-title">
            <ViewIntro eyebrow="变更记录" title="事件日志" id="activity-view-title" description="查看探针注册、IP 变化、DNS 同步和 Nyanpass 实例登记记录。" />
            <ActivityPanel events={events} now={now} expanded />
          </section>}
        </div>
      </section>

      {showCreate && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
          <button className="modal-close" onClick={closeModal} aria-label="关闭" disabled={saving}>×</button>
          {!created ? <><p className="eyebrow cyan">探针对接</p><h2 id="create-title">添加一个探针节点</h2><p className="modal-intro">先填好 SSH 密码和全部 Nyanpass 实例。创建后会生成一条“公共安装脚本 + 节点专属参数”的对接命令，执行后按 DDNS 验收 → 全部 Nyanpass → BBR → SSH 自动完成安装。</p>
            <form onSubmit={createNode} className="node-form">
              <label>节点名称<input name="name" required placeholder="例如：东京 · jp-01" /></label>
              <label>区域<input name="region" placeholder="ap-northeast" /></label>
              <label>一次性 root 密码<input name="rootPassword" type="password" required minLength={8} maxLength={128} autoComplete="new-password" placeholder="8-128 个字符" /></label>
              <p className="form-hint">root 密码只会随开机安装凭据加密暂存，不会进入节点列表、事件或日志；安装成功后主控会立即擦除。</p>
              <p className="form-hint">原脚本的 23 项 BBR + fq/sysctl 参数固定启用，公共安装器会在内部显式调用 <code>--bbr 1</code>；覆盖前仍会备份 `/etc/sysctl.conf`。</p>
              <label>阿里云主域名<input name="domainName" placeholder="example.com" /></label>
              <div className="form-grid"><label>IPv4 主机记录<input name="recordV4" placeholder="home 或 @" /></label><label>IPv6 主机记录<input name="recordV6" placeholder="home 或 @" /></label></div>
              <p className="form-hint">例如 home.example.com：主域名填 example.com，主机记录填 home；根域名填 @。</p>
              <fieldset className="nyanpass-batch"><legend>Nyanpass 实例（可添加多个）</legend>{nodeNyanpass.map((instance, index) => <div className="nyanpass-draft" key={index}>
                <div className="nyanpass-draft-head"><strong>实例 {index + 1}</strong>{nodeNyanpass.length > 1 && <button type="button" className="inline-remove" onClick={() => setNodeNyanpass((current) => current.filter((_, itemIndex) => itemIndex !== index))}>移除</button>}</div>
                <label>服务名称<input required value={instance.name} onChange={(event) => updateNodeNyanpass(index, 'name', event.target.value)} placeholder="例如：tenant-a-out" /></label>
                <label>官方安装命令<textarea required rows={3} autoComplete="off" spellCheck={false} value={instance.command} onChange={(event) => updateNodeNyanpass(index, 'command', event.target.value)} placeholder={'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t … -u https://…"'} /></label>
                <label className="nyanpass-check"><input type="checkbox" checked={instance.optimize} onChange={(event) => updateNodeNyanpass(index, 'optimize', event.target.checked)} />启用原脚本 OPTIMIZE=1</label>
              </div>)}<button type="button" className="ghost-button" disabled={nodeNyanpass.length >= 16} onClick={() => setNodeNyanpass((current) => [...current, emptyNyanpassDraft()])}>＋ 添加另一个实例</button></fieldset>
              <p className="form-hint">只用独立 <code>-o</code> 识别出口，没有 <code>-o</code> 就是入口；命令中的其他官方安全参数会原样带入。原始凭据仅以密文暂存，对接命令中的节点参数属于一次性 Bearer 凭据，请勿公开或转发。</p>
              <p className="form-hint">可选的 AWS User data 启动器只绑定一台实例，不能作为 ASG 或 Launch Template 的共享 User data；批量部署时请为每台实例分别创建节点。</p>
              {error && <p className="form-error">{error}</p>}<button className="primary-button wide" disabled={saving}>{saving ? '创建中…' : '创建节点并生成对接命令'}</button>
            </form></>
          : <>
            <p className="eyebrow cyan">节点已创建</p>
            <h2 id="create-title">复制探针对接命令</h2>
            <p className="modal-intro">在目标 VPS 的 root Bash 中执行下面这一行。公共脚本只接收该节点的专属参数，配置下载和安装进度会直接显示在终端；失败后原样重跑即可继续。</p>
            <pre className="install-command">{created.connectCommand}</pre>
            <button type="button" className="primary-button wide" disabled={copyFeedback === 'copying'} onClick={() => copyInstallCommand(created.connectCommand)}>{copyFeedback === 'copying' ? '正在复制…' : copyFeedback === 'success' ? '已复制对接命令' : '复制探针对接命令'}</button>
            {copyFeedback === 'success' && <p className="form-success" role="status">对接命令已复制，请直接粘贴到目标 VPS 的 root Bash 执行。</p>}
            {copyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动选中上方完整对接命令；剪贴板内容没有更新。</p>}
            <details className="advanced-install">
              <summary>AWS User data（可选断网重试）</summary>
              <p className="form-hint">需要在首次开机自动执行时使用。它会注册 cloud-init per-boot 重试并复用 <code>/root</code> 下的缓存；普通 VPS 手动对接不需要复制这一段。</p>
              <pre className="install-command">{created.startupScript}</pre>
              <button type="button" className="ghost-button wide" disabled={startupCopyFeedback === 'copying'} onClick={() => copyStartupScript(created.startupScript)}>{startupCopyFeedback === 'copying' ? '正在复制…' : startupCopyFeedback === 'success' ? '已复制 User data' : '复制 AWS User data'}</button>
              {startupCopyFeedback === 'success' && <p className="form-success" role="status">已按 LF 换行复制，可以直接粘贴到云厂商 User data。</p>}
              {startupCopyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动选中上方完整 User data；剪贴板内容没有更新。</p>}
            </details>
            <button type="button" className="ghost-button wide" onClick={closeModal} disabled={saving}>完成</button>
          </>}
        </section>
      </div>}

      {showNyanpass && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeNyanpassModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="nyanpass-title">
          <button className="modal-close" onClick={closeNyanpassModal} aria-label="关闭" disabled={saving}>×</button>
          {!createdNyanpass ? <><p className="eyebrow cyan">多实例远程同步</p><h2 id="nyanpass-title">添加 Nyanpass 合租实例</h2><p className="modal-intro">直接粘贴官方完整命令。主控只加密保存其中的 Nyanpass Token，安装成功后立即清除；命令不会作为 Shell 下发。</p>
            <form onSubmit={createNyanpassInstance} className="node-form"><label>所属探针节点<select name="nodeId" required defaultValue=""><option value="" disabled>选择节点</option>{nodes.map((node) => <option key={node.id} value={node.id} disabled={isBootstrapLockedStatus(node.nyanpassStatus)}>{node.name} · {node.region} · {node.id.slice(0, 6)}{isBootstrapLockedStatus(node.nyanpassStatus) ? ` · ${bootstrapStatusLabel(node.nyanpassStatus)}` : ''}</option>)}</select></label><label>实例 / 服务名称<input name="name" required placeholder="例如：tenant-a-out" /></label><label>Nyanpass 官方安装命令<textarea name="command" required rows={4} autoComplete="off" spellCheck={false} placeholder={'bash <(curl -fLSs https://dl.nyafw.com/download/nyanpass-install.sh) rel_nodeclient "-o -t … -u https://…"'} /></label><label className="nyanpass-check"><input name="optimize" type="checkbox" />启用原脚本 OPTIMIZE=1</label><p className="form-hint">独立 -o 表示出口，无 -o 表示入口。开机脚本完成预配安装前不能追加远程实例。HTTP 主控链路本身没有 TLS，请只向自己的来源 IP 放行面板端口。</p>{error && <p className="form-error">{error}</p>}<button className="primary-button wide" disabled={saving}>{saving ? '加密保存中…' : '保存实例'}</button></form></>
          : <><p className="eyebrow cyan">实例已保存</p><h2 id="nyanpass-title">同步到 {createdNyanpass.instance.nodeName}</h2><p className="modal-intro">已识别为{nyanpassRoleLabel(createdNyanpass.instance.role)}。点击后任务进入队列，探针会自行领取、安装并回传结果。面板中的“成功”表示官方安装器执行成功。</p>{nyanpassErrors[createdNyanpass.instance.id] && <p className="form-error" role="alert">{nyanpassErrors[createdNyanpass.instance.id]}</p>}{createdNyanpass.instance.syncError && <p className="form-hint" role="status">{createdNyanpass.instance.syncError}</p>}<button type="button" className="primary-button wide" disabled={createdNyanpass.instance.status === 'running' || createdNyanpass.instance.status === 'success' || syncingNyanpassIds.has(createdNyanpass.instance.id)} onClick={() => createdNyanpass.instance.status === 'pending' ? cancelNyanpassSync(createdNyanpass.instance) : requiresFreshNyanpassCommand(createdNyanpass.instance) ? beginNyanpassEdit(createdNyanpass.instance) : syncNyanpassInstance(createdNyanpass.instance)}>{createdNyanpass.instance.status === 'pending' ? '取消尚未领取的排队' : createdNyanpass.instance.status === 'running' ? '机器正在安装，不能取消' : createdNyanpass.instance.status === 'success' ? '安装器执行成功' : requiresFreshNyanpassCommand(createdNyanpass.instance) ? '检查 VPS 后重新配置' : syncingNyanpassIds.has(createdNyanpass.instance.id) ? '正在处理…' : !supportsRemoteSync(createdNyanpassNode?.agentVersion) ? '先升级探针' : !createdNyanpassNodeReady ? '探针未在线' : createdNyanpass.instance.status === 'failed' ? '重试同步' : '同步到机器'}</button><button type="button" className="ghost-button wide" onClick={() => { setCreatedNyanpass(null); setError(''); setCopyFeedback('idle'); }} disabled={saving}>继续添加一个</button><button type="button" className="ghost-button wide" onClick={closeNyanpassModal} disabled={saving}>完成</button></>}
        </section>
      </div>}

      {editingNode && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeNodeEditModal()}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="edit-node-title">
          <button className="modal-close" onClick={closeNodeEditModal} aria-label="关闭" disabled={saving}>×</button>
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
          <button className="modal-close" onClick={closeNyanpassEditModal} aria-label="关闭" disabled={saving}>×</button>
          <><p className="eyebrow cyan">修改与重新同步</p><h2 id="edit-nyanpass-title">编辑 {editingNyanpass.name}</h2><p className="modal-intro">实例名同时作为机器上的 Nyanpass 服务名，创建后不可修改，避免旧服务残留。可重新粘贴官方命令修改入口/出口、面板、Token 或 OPTIMIZE；保存后仍需点击“同步到机器”。</p>
            <form key={editingNyanpass.id} onSubmit={updateNyanpassInstance} className="node-form">
              <label>所属探针节点<input value={editingNyanpass.nodeName} disabled /></label>
              <label>实例 / 机器服务名<input name="name" value={editingNyanpass.name} disabled /></label>
              <p className="form-hint">服务名不能直接改名；如需换名，请新增实例，确认新服务正常后再移除旧登记。</p>
              <label>新的官方安装命令（{editingNyanpassRequiresCommand ? '本次必填' : '不修改时可留空'}）<textarea name="command" required={editingNyanpassRequiresCommand} rows={4} autoComplete="off" spellCheck={false} placeholder={editingNyanpassRequiresCommand ? '请重新粘贴官方完整命令，保存后再点击同步到机器' : '要修改入口/出口、面板、Token 或 OPTIMIZE 时粘贴新命令'} /></label>
              <label className="nyanpass-check"><input name="optimize" type="checkbox" defaultChecked={editingNyanpass.optimize} />新命令沿用此 OPTIMIZE 设置</label>
              <p className="form-hint">只修改 OPTIMIZE 开关时也必须重新粘贴官方命令，避免把旧凭据误用于新配置。</p>
              <p className="form-hint">所属节点不能迁移。控制台不会远程停止、卸载或执行任意命令；正在同步时禁止修改。</p>
              {editError && <p className="form-error" role="alert">{editError}</p>}
              <button className="primary-button wide" disabled={saving}>{saving ? '保存中…' : '保存修改'}</button>
            </form></>
        </section>
      </div>}

      {agentUpgrade && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setAgentUpgrade(null); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="agent-upgrade-title"><button className="modal-close" onClick={() => setAgentUpgrade(null)} aria-label="关闭" disabled={saving}>×</button><p className="eyebrow cyan">一次性兼容升级</p><h2 id="agent-upgrade-title">升级 {agentUpgrade.nodeName} 的探针</h2>{agentUpgradeReady ? <><p className="form-success" role="status">已检测到 v{upgradedAgentNode?.agentVersion} 探针正在领取任务，可以返回同步。</p><button type="button" className="primary-button wide" onClick={() => { setAgentUpgrade(null); if (createdNyanpass) setShowNyanpass(true); }}>返回同步</button></> : <><p className="modal-intro">旧探针没有任务领取功能。只需在该 VPS 执行一次下面的命令，原节点令牌和 DDNS 配置会保留；窗口会自动检测升级结果。</p><pre className="install-command">{agentUpgrade.command}</pre><button type="button" className="primary-button wide" disabled={copyFeedback === 'copying'} onClick={() => copyInstallCommand(agentUpgrade.command)}>{copyFeedback === 'copying' ? '正在复制…' : copyFeedback === 'success' ? '已复制升级命令' : '复制探针升级命令'}</button>{copyFeedback === 'success' && <p className="form-success" role="status">复制成功，请在目标 VPS 执行；检测到任务心跳后会自动提示。</p>}{copyFeedback === 'error' && <p className="form-error" role="alert">浏览器拒绝自动复制，请手动选中上方完整命令复制。</p>}</>}<button type="button" className="ghost-button wide" onClick={() => { if (!agentUpgradeReady) setCreatedNyanpass(null); setAgentUpgrade(null); }} disabled={saving}>{agentUpgradeReady ? '关闭' : '稍后完成'}</button></section></div>}
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
        const bootstrapStalled = isAwaitingBootstrapStalled(node, now);
        const bootstrapLocked = isBootstrapLockedStatus(node.nyanpassStatus);
        const sshChanged = ['failed', 'uncertain'].includes(node.nyanpassStatus) && node.provisionLastCompletedStep === 'ssh';
        const removing = removingNodeId === node.id;
        const statusLabel = bootstrapStalled ? 'User data 未执行' : bootstrapLocked ? bootstrapStatusLabel(node.nyanpassStatus) : hasReported ? '已上报' : '等待首次上报';
        return <tr key={node.id}><td><span className="node-name"><i className={hasReported ? '' : 'warn'} />{node.name}</span><small>{node.region}</small></td><td><code>{node.ipv4 ?? '等待 IPv4 上报'}{node.recordV4 ? ` → ${fqdn(node.domainName, node.recordV4)}` : ''}</code><code>{node.ipv6 ?? '等待 IPv6 上报'}{node.recordV6 ? ` → ${fqdn(node.domainName, node.recordV6)}` : ''}</code></td><td>{relativeTime(node.lastSeenAt, now)}</td><td><span className={hasReported && !bootstrapLocked ? 'badge online' : 'badge warning'}>{statusLabel}</span>{bootstrapStalled && <small className="sync-error" role="alert">检查 User data、CRLF 和出站网络</small>}{node.provisionLastCompletedStep && bootstrapLocked && <small>最后完成：{provisionStepLabel(node.provisionLastCompletedStep)}</small>}{sshChanged && <small className="sync-error" role="alert">SSH 凭据已变更，请使用新密码核查</small>}</td><td><div className="row-actions"><button type="button" className="edit-link" disabled={removing} onClick={() => onEdit(node)}>修改</button><button type="button" className="danger-link" disabled={removing} onClick={() => onRemove(node)}>{removing ? '删除中…' : '删除节点'}</button></div></td></tr>;
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
      <div className="security-note"><span>◇</span><div><strong>独立探针凭据</strong><p>节点下载直链只显示一次；数据库仅保存下载 Token 的 SHA-256 摘要，开机凭据加密暂存并在成功后擦除。</p></div></div>
    </div>
  </article>;
}

function NyanpassPanel({ instances, nodes, hasNodes, syncingIds, errors, now, onCreate, onEdit, onRemove, onSync, onCancel, onUpgrade }: { instances: NyanpassRow[]; nodes: NodeRow[]; hasNodes: boolean; syncingIds: Set<string>; errors: Record<string, string>; now: number; onCreate: () => void; onEdit: (instance: NyanpassRow) => void; onRemove: (instance: NyanpassRow) => void; onSync: (instance: NyanpassRow) => void; onCancel: (instance: NyanpassRow) => void; onUpgrade: (node: NodeRow) => void }) {
  const canCreate = nodes.some((node) => !isBootstrapLockedStatus(node.nyanpassStatus));
  return <article className="panel nyanpass-panel">
    <div className="panel-heading"><div><h3>实例与机器同步</h3><p>一个探针可安装多个实例；任务只包含经过校验的 Nyanpass 结构化参数</p></div><button type="button" className="primary-button compact" onClick={onCreate} disabled={!canCreate}>＋ 添加实例</button></div>
    <div className="table-wrap">
      {instances.length ? <table><thead><tr><th>实例 / 所属节点</th><th>面板</th><th>角色</th><th>同步状态</th><th>操作</th></tr></thead><tbody>{instances.map((instance) => {
        const node = nodes.find((item) => item.id === instance.nodeId);
        const capable = supportsRemoteSync(node?.agentVersion);
        const polling = Boolean(node && nodeCanQueueTasks(node, instances, now));
        const provisioning = Boolean(node && isBootstrapLockedStatus(node.nyanpassStatus));
        const busy = instance.status === 'running';
        const syncing = syncingIds.has(instance.id);
        const requiresCommand = requiresFreshNyanpassCommand(instance);
        const syncLabel = syncing ? '正在处理…' : provisioning ? (node ? bootstrapStatusLabel(node.nyanpassStatus) : '开机状态异常') : instance.status === 'pending' ? '取消排队' : instance.status === 'running' ? '机器正在安装…' : !capable ? '先升级探针' : requiresCommand ? '配置后同步' : !polling ? '探针未在线' : instance.status === 'failed' ? '重试同步' : '同步到机器';
        const syncAction = instance.status === 'pending' ? () => onCancel(instance) : !capable && node ? () => onUpgrade(node) : requiresCommand ? () => onEdit(instance) : () => onSync(instance);
        return <tr key={instance.id}><td><span className="node-name">{instance.name}</span><small>{instance.nodeName}{node?.agentVersion ? ` · 探针 ${node.agentVersion}${node.lastTaskPollAt ? ` · ${relativeTime(node.lastTaskPollAt, now)}轮询` : ' · 未见任务心跳'}` : ' · 旧探针'}</small></td><td><code>{displayHost(instance.panelUrl)}</code></td><td><b className={`role-badge ${instance.role}`}>{nyanpassRoleLabel(instance.role)}</b><small>{instance.role === 'outbound' ? '含独立 -o' : '不含 -o'}</small></td><td><NyanpassStatus instance={instance} now={now} />{(errors[instance.id] || instance.syncError) && <small className="sync-error" role="alert">{errors[instance.id] || instance.syncError}</small>}</td><td><div className="row-actions nyanpass-actions"><button type="button" className="sync-link" disabled={provisioning || busy || syncing} aria-busy={busy || syncing} onClick={syncAction}>{syncLabel}</button><button type="button" className="edit-link" disabled={provisioning || instance.status === 'pending' || busy || syncing} onClick={() => onEdit(instance)}>修改</button><button type="button" className="danger-link" disabled={provisioning || instance.status === 'pending' || busy || syncing} onClick={() => onRemove(instance)}>移除登记</button></div></td></tr>;
      })}</tbody></table> : <div className="empty-state compact-empty"><span>⇄</span><h4>还没有合租实例</h4><p>{hasNodes ? canCreate ? '添加第一个 Nyanpass 实例；同一节点可以继续添加多个。' : '请等待节点开机安装完成后再追加实例。' : '请先创建探针节点，再添加 Nyanpass 合租实例。'}</p><button type="button" className="ghost-button" disabled={!canCreate} onClick={onCreate}>添加实例</button></div>}
    </div>
  </article>;
}

function NyanpassStatus({ instance, now }: { instance: NyanpassRow; now: number }) {
  const states: Record<NyanpassStatusValue, { label: string; className: string }> = {
    ready: { label: '已保存，待下发', className: 'warning' },
    pending: { label: '等待机器领取', className: 'pending' },
    running: { label: '机器安装中', className: 'running' },
    success: { label: '同步成功', className: 'online' },
    failed: { label: '同步失败', className: 'failed' },
    uncertain: { label: '结果未知', className: 'failed' },
    bootstrap: { label: '随开机脚本预配', className: 'neutral' },
    legacy: { label: '旧登记', className: 'neutral' },
    '等待安装': { label: '旧登记', className: 'neutral' },
  };
  const state = states[instance.status] ?? { label: '未知状态', className: 'failed' };
  const taskDetail = instance.status === 'pending' && instance.taskCreatedAt
    ? `${relativeTime(instance.taskCreatedAt, now)}入队`
    : instance.status === 'running' && instance.taskLeaseExpiresAt
      ? `最晚 ${new Date(instance.taskLeaseExpiresAt).toLocaleTimeString()} 回执`
      : null;
  return <><span className={`badge ${state.className}`}>{state.label}</span>{instance.status === 'success' && instance.lastReportedAt && <small>{relativeTime(instance.lastReportedAt, now)}完成</small>}{taskDetail && <small>{taskDetail}</small>}</>;
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

function supportsRemoteSync(version: string | null | undefined) {
  if (!version) return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 || minor >= 8;
}

function hasRecentTaskPoll(node: Pick<NodeRow, 'lastTaskPollAt'>, now: number) {
  if (!node.lastTaskPollAt || !now) return false;
  return now - Date.parse(node.lastTaskPollAt) <= 2 * 60 * 1000;
}

function requiresFreshNyanpassCommand(instance: Pick<NyanpassRow, 'status' | 'hasCredential'>) {
  if (!['ready', 'pending', 'running', 'failed'].includes(instance.status)) return true;
  return !['pending', 'running'].includes(instance.status) && !instance.hasCredential;
}

function isBootstrapLockedStatus(status: string) {
  return ['awaiting', 'provisioning', 'failed', 'uncertain'].includes(status);
}

function bootstrapStatusLabel(status: string) {
  if (status === 'awaiting') return '等待执行开机脚本';
  if (status === 'provisioning') return '开机安装中';
  if (status === 'failed') return '开机安装失败待恢复';
  return '开机安装结果未知';
}

function isAwaitingBootstrapStalled(node: Pick<NodeRow, 'nyanpassStatus' | 'createdAt'>, now: number) {
  return node.nyanpassStatus === 'awaiting' && Boolean(now) && now - Date.parse(node.createdAt) >= 10 * 60 * 1000;
}

function provisionStepLabel(step: string) {
  return ({ ddns: 'DDNS', nyanpass: 'Nyanpass', bbr: 'BBR', ssh: 'SSH' } as Record<string, string>)[step] ?? step;
}

async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit, timeoutMs = 45_000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function nodeCanQueueTasks(node: Pick<NodeRow, 'id' | 'lastTaskPollAt'>, instances: NyanpassRow[], now: number) {
  if (hasRecentTaskPoll(node, now)) return true;
  return instances.some((instance) => instance.nodeId === node.id && instance.status === 'running'
    && Boolean(instance.taskLeaseExpiresAt) && Date.parse(instance.taskLeaseExpiresAt!) > now);
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
    nyanpass_sync_queued: 'Nyanpass 等待同步',
    nyanpass_sync_started: 'Nyanpass 开始同步',
    nyanpass_sync_succeeded: 'Nyanpass 同步成功',
    nyanpass_sync_failed: 'Nyanpass 同步失败',
    nyanpass_sync_uncertain: 'Nyanpass 结果未知',
    nyanpass_sync_canceled: 'Nyanpass 取消排队',
    nyanpass_bootstrap_succeeded: '开机安装成功',
    nyanpass_bootstrap_failed: '开机安装失败',
    nyanpass_bootstrap_started: '开机安装开始',
    nyanpass_bootstrap_uncertain: '开机安装结果未知',
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
