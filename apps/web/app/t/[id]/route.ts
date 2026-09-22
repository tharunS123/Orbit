import { redirect } from 'next/navigation';
import { isUuid, routes } from '@orbit/shared';

/** Short share link → in-app route (native apps claim /t/* as a universal/app link). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(isUuid(id) ? routes.task(id) : routes.inbox());
}
