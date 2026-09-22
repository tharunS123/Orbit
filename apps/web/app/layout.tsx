import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { PRODUCT } from '@orbit/shared';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: PRODUCT.name, template: `%s · ${PRODUCT.name}` },
  description: `${PRODUCT.name} — ${PRODUCT.tagline} Tasks, notes and meetings in one calm, fast, offline-first workspace.`,
  applicationName: PRODUCT.name,
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: PRODUCT.name, statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf9f6' },
    { media: '(prefers-color-scheme: dark)', color: '#1c1b19' },
  ],
};

// Applied before first paint so there is no light/dark flash.
const themeScript = `(()=>{try{var t=localStorage.getItem('orbit.theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
