import { getApi } from '@orbit/api';
import { EnvError } from '@orbit/shared/env';
import { apiExtensions } from '@/server/extensions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(req: Request): Promise<Response> {
  try {
    const app = await getApi(apiExtensions);
    return await app.fetch(req);
  } catch (error) {
    if (error instanceof EnvError) {
      console.error(error.message);
      return Response.json(
        { error: { code: 'unavailable', message: process.env.NODE_ENV === 'production' ? 'Server is not configured.' : error.message } },
        { status: 503 },
      );
    }
    throw error;
  }
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE, handler as OPTIONS };
