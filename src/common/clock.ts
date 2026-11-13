import { Injectable } from '@nestjs/common';

/** Inject this instead of calling new Date(), so month-end and retry timing can be tested. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
