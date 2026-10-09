import { normalize } from './core/normalize';
import { parseOtlp } from './core/parse';
import { diagnostic } from './core/types';

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ data: normalize(parseOtlp(event.data)) });
  } catch (error) {
    self.postMessage({ error: diagnostic(error) });
  }
};
