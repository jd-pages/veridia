export interface ResultDrawerRequestToken {
  generation: number;
  resultId: string;
  signal: AbortSignal;
}

export class ResultDrawerRequestIdentity {
  private generation = 0;
  private resultId: string | null = null;
  private controller: AbortController | null = null;

  begin(resultId: string): ResultDrawerRequestToken {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.resultId = resultId;
    return {
      generation: ++this.generation,
      resultId,
      signal: controller.signal,
    };
  }

  invalidate() {
    this.generation += 1;
    this.resultId = null;
    this.controller?.abort();
    this.controller = null;
  }

  owns(request: ResultDrawerRequestToken) {
    return (
      request.generation === this.generation &&
      request.resultId === this.resultId &&
      !request.signal.aborted
    );
  }

  accepts(request: ResultDrawerRequestToken, responseResultId: string) {
    return this.owns(request) && responseResultId === request.resultId;
  }
}

export function ownsSelectedResultDrawerRequest(
  identity: ResultDrawerRequestIdentity,
  request: ResultDrawerRequestToken,
  selectedResultId: string | null,
) {
  return selectedResultId === request.resultId && identity.owns(request);
}
