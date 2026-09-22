import type { MetadataRoute } from 'next';
import { PRODUCT } from '@orbit/shared';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT.name,
    short_name: PRODUCT.name,
    description: PRODUCT.tagline,
    start_url: '/inbox',
    display: 'standalone',
    background_color: '#faf9f6',
    theme_color: '#5b54e8',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New task', url: '/inbox?capture=1' },
      { name: 'Today', url: '/today' },
    ],
  };
}
