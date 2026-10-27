export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 429 | 503 = 400,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}
