import { NextRequest, NextResponse } from 'next/server';

// 探针安装脚本固定从 GitHub 按 commit 下载，面板本身不提供。
const SCRIPT_PATHS = new Set(['/install.sh', '/monitor.sh', '/update.sh']);

export function proxy(request: NextRequest) {
  if (SCRIPT_PATHS.has(request.nextUrl.pathname)) {
    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  // 登录与权限由各页面和接口自行校验（会话 Cookie）；这里统一加上禁止被嵌入的响应头，
  // 防止点击劫持。
  const response = NextResponse.next();
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  return response;
}
