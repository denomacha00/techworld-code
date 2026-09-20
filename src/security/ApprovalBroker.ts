import { createHash, randomUUID } from 'node:crypto';

export interface ApprovalRequest<T> {
  id: string;
  fingerprint: string;
  proposal: T;
}

export class ApprovalBroker {
  private readonly requests = new Map<string, ApprovalRequest<unknown>>();

  request<T>(proposal: T): ApprovalRequest<T> {
    const serialized = JSON.stringify(proposal);
    const request: ApprovalRequest<T> = {
      id: randomUUID(),
      fingerprint: createHash('sha256').update(serialized).digest('hex'),
      proposal
    };
    this.requests.set(request.id, request);
    return request;
  }

  /**
   * Validate the user's approval of a specific proposal. An approval is valid until it is consumed once
   * or explicitly rejected — deliberately NOT time-boxed. The wait for the user's click has no timeout,
   * so a slow-but-genuine approval (reviewing a big diff, stepping away) must still be honored. A stale
   * time cap here silently turned a real "Approve" click into "The user rejected…", which read as the
   * agent randomly refusing to edit files or run commands. The real safety properties are: single-use
   * (deleted on consume) and exact-payload match (fingerprint) — nothing but the change the user saw runs.
   */
  consume<T>(id: string, proposal: T): boolean {
    const request = this.requests.get(id);
    this.requests.delete(id);
    if (!request) { return false; }
    const fingerprint = createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
    return request.fingerprint === fingerprint;
  }

  reject(id: string): void {
    this.requests.delete(id);
  }
}
