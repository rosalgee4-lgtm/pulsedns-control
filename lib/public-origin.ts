import { basePath } from '@/lib/auth';

// 生成安装命令和开机脚本里的面板地址。面板运行在宝塔等反向代理之后，
// 必须用 PULSEDNS_PUBLIC_URL 指明对外的 HTTPS 地址（例如 https://panel.example.com），
// 随机入口路径会自动追加在后面。只有 PULSEDNS_ALLOW_HTTP=1 的本机测试才允许 http。
export function publicOrigin(request: Request) {
  const configured = process.env.PULSEDNS_PUBLIC_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && process.env.PULSEDNS_ALLOW_HTTP === '1');
      if (allowed && !url.username && !url.password && !url.search && !url.hash) {
        const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
        return `${url.origin}${pathname}${basePath()}`;
      }
    } catch {
      // 配置格式错误时退回请求地址；启动检查会提示。
    }
  }
  return `${new URL(request.url).origin}${basePath()}`;
}
