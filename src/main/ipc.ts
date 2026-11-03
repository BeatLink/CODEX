export type StatusResponse = {
  ready?: boolean;
  model?: string;
  [key: string]: unknown;
};

export function normalizeStatusResponse(payload: Record<string, unknown>): StatusResponse {
  if (!payload || Object.keys(payload).length === 0) {
    throw new Error('Daemon status payload is empty.');
  }

  const result = { ...payload } as StatusResponse;
  if (typeof result.ready !== 'boolean') {
    result.ready = Boolean(result.ready);
  }

  return result;
}
