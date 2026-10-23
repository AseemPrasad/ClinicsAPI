export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'CLINIC_NOT_FOUND'
  | 'SLOT_NOT_FOUND'
  | 'INVALID_TIME_RANGE'
  | 'SLOT_STARTS_IN_PAST'
  | 'SLOT_HAS_CONFIRMED_BOOKING'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;

  public constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
