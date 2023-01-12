interface BaseValidityResult {
  isValid: boolean;
}
export interface Valid<T> extends BaseValidityResult {
  isValid: true;
  data: T;
}

export interface Invalid extends BaseValidityResult {
  isValid: false;
  reason: string;
}

export type ValidityResult<T> = Valid<T> | Invalid;
