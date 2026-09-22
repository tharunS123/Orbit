'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { routes } from '@orbit/shared';
import { Button } from '@orbit/ui';
import { TaskDetail } from '@/features/tasks/task-detail';
import { useStoreQuery } from '@/lib/sync';

function TaskPageView() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get('id') ?? '';
  const task = useStoreQuery(['tasks'], (s) => s.get('tasks', id), [id]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 items-center px-3">
        <Button variant="ghost" size="sm" onClick={() => (window.history.length > 1 ? router.back() : router.push(task?.listId ? routes.list(task.listId) : routes.inbox()))}>
          <ArrowLeft /> Back
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <TaskDetail key={id} taskId={id} mode="page" onOpenTask={(t) => router.push(routes.task(t))} />
      </div>
    </div>
  );
}

export default function TaskPage() {
  return (
    <React.Suspense>
      <TaskPageView />
    </React.Suspense>
  );
}
