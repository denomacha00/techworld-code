import { createHash, randomUUID } from 'node:crypto';

export interface ApprovalRequest<T> {
  id: string;
  fingerprint: string;
  proposal: T;
  expiresAt: number;
}

export class ApprovalBroker {
  private readonly requests = new Map<string, ApprovalRequest<unknown>>();

  request<T>(proposal: T): ApprovalRequest<T> {
    const serialized = JSON.stringify(proposal);
    const request: ApprovalRequest<T> = {
      id: randomUUID(),
      fingerprint: createHash('sha256').update(serialized).digest('hex'),
      proposal,
      expiresAt: Date.now() + 10 * 60 * 1000
    };
    this.requests.set(request.id, request);
    return request;
  }

  consume<T>(id: string, proposal: T): boolean {
    const request = this.requests.get(id);
    this.requests.delete(id);
    if (!request || request.expiresAt < Date.now()) { return false; }
    const fingerprint = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    return request.fingerprint === fingerprint;
  }

  reject(id: string): void {
    this.requests.delete(id);
  }
}
