import { redirect } from 'next/navigation';
import { routes } from '@orbit/shared';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  redirect(/^[A-Za-z0-9_-]{20,200}$/.test(token) ? routes.invite(token) : '/');
}
