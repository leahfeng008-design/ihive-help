import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'iHive 帮助助手', description: '基于 iHive 官方客户端与管理后台帮助文档的 AI 问答助手。', icons: { icon: '/bee-assistant.png' } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
