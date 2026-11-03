export type DaemonRequest = {
    id: string;
    method: string;
    params: Record<string, unknown>;
};

export type DaemonResponse =
    | { id: string; result: unknown }
    | { id: string; error: string }
    | { event: string; data?: unknown };

export function buildRequest(method: string, params: Record<string, unknown> = {}): DaemonRequest {
    return {
        id: `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        method,
        params,
    };
}

export function isSuccessfulResponse(response: DaemonResponse): boolean {
    if ('result' in response) {
        return true;
    }

    if ('error' in response) {
        return false;
    }

    return false;
}
