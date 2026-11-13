/**
 * Jev as a Decider: one System One call per album, one yes/no question per
 * tracklist group. build makes the request with jevPayloadFor (the payload
 * preview shows the same request); ask sends the payload it is given as it
 * is, never rebuilt. A group whose answer is missing or not a number is
 * left out of the probabilities, so the decision reads the answer as
 * invalid (no pick) rather than as a "no".
 */
import { jevPayloadFor, jevSpecHash, questionName, requestBytes, type Decider, type JevRequest } from '@tagave/core';
import { systemOne, type JevClientOptions } from './jevClient.js';

export function jevDecider(client: JevClientOptions): Decider {
  return {
    id: 'jev',
    specHash: jevSpecHash(),
    build: jevPayloadFor,
    async ask(input, { model }) {
      // made by build above
      const req = input.payload as JevRequest;
      if (req?.model !== model) throw new Error('jev request: built for another model');
      const res = await systemOne(client, req);
      const probabilities: Record<string, number> = {};
      for (const g of input.groups) {
        const a = res.answers[questionName(g.label)];
        if (typeof a?.noul === 'number') probabilities[g.label] = a.noul;
      }
      return { probabilities, model: res.model, inputTokens: res.usage.input_tokens, requestBytes: requestBytes(req), raw: res.answers };
    },
  };
}
