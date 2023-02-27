interface BaseValidityResult {
  isValid: boolean;
}

export interface Valid extends BaseValidityResult {
  isValid: true;
}
export interface ValidWithData<T> extends BaseValidityResult {
  isValid: true;
  data: T;
}

export interface Invalid extends BaseValidityResult {
  isValid: false;
  reason: string;
  isTransient: boolean;
}

export type ValidityResultWithData<T> = ValidWithData<T> | Invalid;

export type ValidityResult = Valid | Invalid;
