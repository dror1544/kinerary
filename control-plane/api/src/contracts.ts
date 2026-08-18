export type AdapterOperation =
  | "inspect"
  | "create"
  | "verify"
  | "delete"
  | "inventory";

export interface AdapterRequest<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  schema_version: 1;
  request_id: string;
  correlation_id: string;
  idempotency_key: string;
  adapter: string;
  operation: AdapterOperation;
  test_run_id?: string;
  payload: TPayload;
}

export interface AdapterResult<TData extends Record<string, unknown> = Record<string, unknown>> {
  schema_version: 1;
  request_id: string;
  correlation_id: string;
  idempotency_key: string;
  adapter: string;
  operation: AdapterOperation;
  status: "succeeded" | "failed" | "not_found";
  changed: boolean;
  safe_error_code?: string;
  data?: TData;
}

export interface ProviderAdapter {
  execute(request: AdapterRequest): Promise<AdapterResult>;
}
