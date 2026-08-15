import type { AdapterRequest, AdapterResult, ProviderAdapter } from "../contracts.js";

export class FakeAdapter implements ProviderAdapter {
  readonly requests: AdapterRequest[] = [];

  constructor(private readonly behavior: "succeed" | "fail" = "succeed") {}

  async execute(request: AdapterRequest): Promise<AdapterResult> {
    this.requests.push(structuredClone(request));
    return {
      schema_version: 1,
      request_id: request.request_id,
      correlation_id: request.correlation_id,
      idempotency_key: request.idempotency_key,
      adapter: request.adapter,
      operation: request.operation,
      status: this.behavior === "succeed" ? "succeeded" : "failed",
      changed: false,
      ...(this.behavior === "fail" ? { safe_error_code: "FAKE_CONTROLLED_FAILURE" } : {}),
    };
  }
}
