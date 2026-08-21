import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'PulseDNS · 网络控制台',
  description: '支持阿里云 DNS 与多 Nyanpass 合租实例的安全网络控制台。',
  openGraph: {
    title: 'PulseDNS · 网络控制台',
    description: '支持阿里云 DNS 与多 Nyanpass 合租实例的安全网络控制台。',
    type: 'website',
    images: process.env.SITE_ORIGIN ? [{ url: new URL('/og.png', process.env.SITE_ORIGIN).toString(), width: 1200, height: 630, alt: 'PulseDNS 安全动态 DNS 控制台' }] : [],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PulseDNS · 网络控制台',
    description: '支持阿里云 DNS 与多 Nyanpass 合租实例的安全网络控制台。',
    images: process.env.SITE_ORIGIN ? [new URL('/og.png', process.env.SITE_ORIGIN).toString()] : [],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
