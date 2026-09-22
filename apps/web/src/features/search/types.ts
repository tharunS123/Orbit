export type SearchType = 'task' | 'list' | 'note' | 'comment' | 'meeting' | 'transcript' | 'file' | 'person' | 'label';

/** Mirror of the API's SearchResult (packages/api/src/routes/search.ts). */
export interface SearchResultDto {
  type: SearchType;
  id: string;
  title: string;
  snippet: string | null;
  score: number;
  workspaceId: string | null;
  listId: string | null;
  taskId: string | null;
  meetingId: string | null;
  meta: Record<string, unknown>;
}
